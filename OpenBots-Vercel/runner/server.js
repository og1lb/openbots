const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawn } = require("child_process");
const Busboy = require("busboy");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const BOTS_DIR = process.env.BOTS_DIR ? path.resolve(process.env.BOTS_DIR) : path.join(ROOT, "bots");
const OPENBOTS_TOKEN = String(process.env.OPENBOTS_TOKEN || "");
const PUBLIC_DIR = path.join(ROOT, "public");

app.use((req,res,next)=>{
  const origin = process.env.CORS_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  if(req.method === "OPTIONS") return res.sendStatus(204);
  if(OPENBOTS_TOKEN && req.path.startsWith("/api/")){
    const auth = String(req.headers.authorization || "");
    if(auth !== `Bearer ${OPENBOTS_TOKEN}`) return res.status(401).json({ok:false,error:"Unauthorized runner."});
  }
  next();
});
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

const processes = new Map();
const logHistory = new Map();

async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); }

function safeName(name) {
  if (typeof name !== "string" || !name || name === "." || name === "..") return false;
  if (/^[. ]+$/.test(name)) return false;
  if (/[<>:"/\\|?*\x00-\x1F]/.test(name)) return false;
  if (/[ .]$/.test(name)) return false;
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) return false;
  return true;
}

function cleanRelativePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(part => part && part !== "." && part !== "..")
    .join("/");
}

function botPath(name) {
  if (!safeName(name)) throw new Error("Invalid bot name.");
  const base = path.resolve(BOTS_DIR);
  const resolved = path.resolve(base, name);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error("Invalid bot path.");
  return resolved;
}

function targetPath(root, relative) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error("Invalid upload path.");
  return resolved;
}

async function importUploadedFolder(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 5000, fields: 20, fieldSize: 5 * 1024 * 1024, fileSize: 250 * 1024 * 1024 } });
    } catch (e) { reject(e); return; }

    const writes = [];
    const roots = new Set();
    let manifest = null;
    let fileIndex = 0;
    let rejected = false;

    const fail = (err) => {
      if (!rejected) { rejected = true; reject(err); }
    };

    bb.on("field", (name, value) => {
      if (name === "manifest") {
        try {
          const parsed = JSON.parse(value);
          if (!Array.isArray(parsed)) throw new Error("Invalid upload manifest.");
          manifest = parsed.map(v => cleanRelativePath(v));
        } catch (e) { fail(new Error("Invalid upload manifest.")); }
      }
    });

    bb.on("file", (fieldname, file, info) => {
      const index = fileIndex++;
      // The browser sends the real relative path in manifest; info.filename is only the file basename.
      const original = manifest?.[index] || cleanRelativePath(info.filename);
      if (!original) { file.resume(); return; }

      const parts = original.split("/").filter(Boolean);
      if (parts.length < 2) { file.resume(); return; }
      const root = parts.shift();
      if (!safeName(root)) { file.resume(); fail(new Error(`Invalid bot folder name: ${root}`)); return; }
      roots.add(root);

      const relative = parts.join("/");
      if (!relative) { file.resume(); return; }
      if (parts.includes("node_modules") || parts.includes(".git")) { file.resume(); return; }

      let destination;
      try { destination = targetPath(botPath(root), relative); }
      catch (e) { file.resume(); fail(e); return; }

      const promise = (async () => {
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await new Promise((res, rej) => {
          const out = fs.createWriteStream(destination);
          file.on("error", rej); out.on("error", rej); out.on("finish", res);
          file.pipe(out);
        });
      })();
      writes.push(promise);
    });

    bb.on("filesLimit", () => fail(new Error("Too many files. Maximum is 5000.")));
    bb.on("error", fail);
    bb.on("finish", async () => {
      if (rejected) return;
      try {
        if (!manifest || !manifest.length) throw new Error("No folder manifest received. Please select/drop the folder itself, not individual files.");
        if (fileIndex !== manifest.length) throw new Error(`Upload mismatch: received ${fileIndex} files but expected ${manifest.length}.`);
        await Promise.all(writes);
        if (!roots.size) throw new Error("No valid bot folder was uploaded.");
        resolve([...roots]);
      } catch (e) { fail(e); }
    });

    req.pipe(bb);
  });
}
async function listBots() {
  await ensureDir(BOTS_DIR);
  const entries = await fsp.readdir(BOTS_DIR, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeName(entry.name)) continue;
    const dir = botPath(entry.name);
    const pkgFile = path.join(dir, "package.json");
    const envFile = path.join(dir, ".env");
    const hasPackage = fs.existsSync(pkgFile);
    const hasEnv = fs.existsSync(envFile);
    let pkg = {};
    if (hasPackage) { try { pkg = JSON.parse(await fsp.readFile(pkgFile, "utf8")); } catch {} }
    const state = processes.get(entry.name);
    result.push({
      name: entry.name,
      running: !!state,
      pid: state?.child?.pid || null,
      hasPackage,
      hasEnv,
      startScript: pkg?.scripts?.start || null,
      main: pkg?.main || null,
      packageManager: pkg?.packageManager || "npm"
    });
  }
  return result.sort((a,b)=>a.name.localeCompare(b.name));
}

function npmCommand() { return process.platform === "win32" ? "npm.cmd" : "npm"; }
function executableForPackage(botDir, pkg) {
  if (pkg?.scripts?.start) return { command: npmCommand(), args: ["start"] };
  if (pkg?.main) return { command: process.execPath, args: [path.resolve(botDir, pkg.main)] };
  for (const candidate of ["index.js","main.js","bot.js","src/index.js","index.cjs","index.mjs"]) {
    if (fs.existsSync(path.join(botDir, candidate))) return { command: process.execPath, args: [path.join(botDir, candidate)] };
  }
  return null;
}

async function readPackage(botDir) {
  const file = path.join(botDir, "package.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

function parseEnv(text) {
  const result = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i < 1) continue;
    const key = trimmed.slice(0,i).trim();
    let value = trimmed.slice(i+1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1,-1);
    if (key) result[key] = value;
  }
  return result;
}

async function botEnvironment(dir) {
  const file = path.join(dir, ".env");
  if (!fs.existsSync(file)) return { ...process.env };
  const text = await fsp.readFile(file, "utf8");
  return { ...process.env, ...parseEnv(text) };
}

function appendLog(name, line) {
  let logs = logHistory.get(name);
  if (!logs) { logs = []; logHistory.set(name, logs); }
  logs.push(line);
  if (logs.length > 1000) logs.splice(0, logs.length - 1000);
}

async function installDependencies(name) {
  const dir = botPath(name);
  const pkgFile = path.join(dir, "package.json");
  if (!fs.existsSync(pkgFile)) throw new Error("package.json is missing.");

  appendLog(name, "[DEPLOY] npm install started...");
  const child = spawn(npmCommand(), ["install", "--no-audit", "--no-fund"], {
    cwd: dir, shell: false, windowsHide: true,
    env: await botEnvironment(dir), stdio: ["ignore","pipe","pipe"]
  });

  await new Promise((resolve,reject)=>{
    let stderr = "", stdout = "";
    child.stdout.on("data", d => { const s=d.toString(); stdout += s; s.split(/\r?\n/).filter(Boolean).forEach(x=>appendLog(name,`[NPM] ${x}`)); });
    child.stderr.on("data", d => { const s=d.toString(); stderr += s; s.split(/\r?\n/).filter(Boolean).forEach(x=>appendLog(name,`[NPM ERR] ${x}`)); });
    child.on("error", err => reject(new Error(`Could not start npm: ${err.message}`)));
    child.on("close", code => code===0 ? resolve() : reject(new Error(`npm install failed with exit code ${code}.\n${(stderr||stdout).slice(-12000)}`)));
  });
  appendLog(name, "[DEPLOY] npm install finished.");
}

async function startProcess(name) {
  if (processes.has(name)) throw new Error("Bot is already running.");
  const dir = botPath(name);
  const pkg = await readPackage(dir);
  const executable = executableForPackage(dir, pkg);
  if (!executable) throw new Error("No start script or JavaScript entry file was found.");

  const child = spawn(executable.command, executable.args, {
    cwd: dir, shell: false, windowsHide: true,
    env: await botEnvironment(dir), stdio: ["ignore","pipe","pipe"]
  });

  appendLog(name, `[PROCESS] Starting: ${executable.command} ${executable.args.join(" ")}`);
  const state = { child, startedAt: Date.now() };
  processes.set(name, state);
  child.stdout.on("data", d=>d.toString().split(/\r?\n/).filter(Boolean).forEach(x=>appendLog(name,`[OUT] ${x}`)));
  child.stderr.on("data", d=>d.toString().split(/\r?\n/).filter(Boolean).forEach(x=>appendLog(name,`[ERR] ${x}`)));
  child.on("error", err=>{appendLog(name,`[PROCESS ERROR] ${err.message}`);processes.delete(name)});
  child.on("close", code=>{appendLog(name,`[PROCESS EXIT] code=${code}`);processes.delete(name)});
  return { pid: child.pid };
}

function stopProcess(name) {
  const state = processes.get(name);
  if (!state) return false;
  try {
    if (process.platform === "win32") spawn("taskkill.exe", ["/pid",String(state.child.pid),"/T","/F"], { windowsHide:true, shell:false, stdio:"ignore" });
    else state.child.kill("SIGTERM");
    appendLog(name, "[PROCESS] Stop requested.");
  } finally { processes.delete(name); }
  return true;
}

app.get("/api/bots", async (_req,res)=>{try{res.json({ok:true,bots:await listBots()})}catch(e){res.status(500).json({ok:false,error:e.message})}});

app.post("/api/upload-folder", async (req,res)=>{try{const names=await importUploadedFolder(req);res.json({ok:true,bots:names,message:`Uploaded ${names.length} bot folder${names.length===1?"":"s"}: ${names.join(", ")}`})}catch(e){res.status(400).json({ok:false,error:e.message})}});

app.get("/api/bots/:name/env",async(req,res)=>{try{const file=path.join(botPath(req.params.name),".env");res.json({ok:true,text:fs.existsSync(file)?await fsp.readFile(file,"utf8"):""})}catch(e){res.status(400).json({ok:false,error:e.message})}});
app.put("/api/bots/:name/env",async(req,res)=>{try{const dir=botPath(req.params.name);await ensureDir(dir);await fsp.writeFile(path.join(dir,".env"),typeof req.body.text==="string"?req.body.text:"","utf8");res.json({ok:true})}catch(e){res.status(400).json({ok:false,error:e.message})}});

app.post("/api/bots/:name/deploy",async(req,res)=>{const name=req.params.name;try{if(processes.has(name)){stopProcess(name);await new Promise(r=>setTimeout(r,700))}await installDependencies(name);const started=await startProcess(name);res.json({ok:true,pid:started.pid,message:"Bot deployed and started."})}catch(e){appendLog(name,`[DEPLOY ERROR] ${e.message}`);res.status(400).json({ok:false,error:e.message})}});
app.post("/api/bots/:name/stop",(req,res)=>{try{res.json({ok:true,stopped:stopProcess(req.params.name)})}catch(e){res.status(400).json({ok:false,error:e.message})}});
app.post("/api/bots/:name/restart",async(req,res)=>{const name=req.params.name;try{stopProcess(name);await new Promise(r=>setTimeout(r,700));await installDependencies(name);const started=await startProcess(name);res.json({ok:true,pid:started.pid})}catch(e){appendLog(name,`[RESTART ERROR] ${e.message}`);res.status(400).json({ok:false,error:e.message})}});
app.get("/api/bots/:name/logs",(req,res)=>{try{botPath(req.params.name);res.json({ok:true,running:processes.has(req.params.name),logs:logHistory.get(req.params.name)||[]})}catch(e){res.status(400).json({ok:false,error:e.message})}});

app.get("*splat",(_req,res)=>res.sendFile(path.join(PUBLIC_DIR,"index.html")));

ensureDir(BOTS_DIR).then(()=>app.listen(PORT,()=>{console.log(`OpenBots running at http://localhost:${PORT}`);console.log(`Bots directory: ${BOTS_DIR}`)})).catch(err=>{console.error(err);process.exit(1)});
