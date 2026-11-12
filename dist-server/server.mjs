// server.ts
import express from "express";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import dotenv from "dotenv";
import JSZip from "jszip";

// lib/owner-auth.ts
async function checkOwnerAuth(_tokenOrKey) {
  return { authorized: true };
}

// lib/worker-proxy.ts
async function forwardWorker(req, res, suffix, method, body) {
  const url = process.env.INGEST_WORKER_URL;
  const secret = process.env.INGEST_WORKER_SECRET;
  if (!url || !secret) return res.status(503).json({ error: "Ingestion worker is not configured." });
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}${suffix}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      ...body === void 0 ? {} : { body: JSON.stringify(body) },
      signal: AbortSignal.timeout(45e3)
    });
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(response.status).json(await response.json());
  } catch {
    return res.status(502).json({ error: "Ingestion worker unavailable. Please retry; browser ingestion was not started." });
  }
}
function submitWorkerJob(req, res) {
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : void 0;
  const incoming = bearer || req.body?.token;
  const ownerKey = (process.env.OWNER_ACCESS_KEY || process.env.OWNER_PASSPHRASE || "honeypie3301-84184414").trim();
  const token = incoming && incoming !== ownerKey ? incoming : process.env.GITHUB_TOKEN || "";
  return forwardWorker(req, res, "/jobs", "POST", { ...req.body, token });
}
async function handleWorkerJob(req, res) {
  const auth = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : req.body?.token || process.env.GITHUB_TOKEN;
  const check = await checkOwnerAuth(auth);
  if (!check.authorized) return res.status(check.status || 401).json({ error: check.reason || "Unauthorized" });
  const id = String(req.query?.id || req.params?.id || "");
  if (!/^[a-f0-9-]{36}$/.test(id)) return res.status(400).json({ error: "Invalid job ID." });
  if (!["GET", "DELETE"].includes(req.method)) return res.status(405).json({ error: "Method not allowed." });
  return forwardWorker(req, res, `/jobs/${id}`, req.method);
}

// src/services/decompiler/javaClassDecompiler.ts
var CONSTANT_Utf8 = 1;
var CONSTANT_Integer = 3;
var CONSTANT_Float = 4;
var CONSTANT_Long = 5;
var CONSTANT_Double = 6;
var CONSTANT_Class = 7;
var CONSTANT_String = 8;
var CONSTANT_Fieldref = 9;
var CONSTANT_Methodref = 10;
var CONSTANT_InterfaceMethodref = 11;
var CONSTANT_NameAndType = 12;
var CONSTANT_MethodHandle = 15;
var CONSTANT_MethodType = 16;
var CONSTANT_Dynamic = 17;
var CONSTANT_InvokeDynamic = 18;
var CONSTANT_Module = 19;
var CONSTANT_Package = 20;
var ACC_PUBLIC = 1;
var ACC_PRIVATE = 2;
var ACC_PROTECTED = 4;
var ACC_STATIC = 8;
var ACC_FINAL = 16;
var ACC_SYNCHRONIZED = 32;
var ACC_VOLATILE = 64;
var ACC_TRANSIENT = 128;
var ACC_NATIVE = 256;
var ACC_INTERFACE = 512;
var ACC_ABSTRACT = 1024;
var ACC_ENUM = 16384;
var ByteReader = class {
  constructor(buffer) {
    this.offset = 0;
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    this.view = new DataView(ab);
  }
  get remaining() {
    return this.view.byteLength - this.offset;
  }
  readU1() {
    const val = this.view.getUint8(this.offset);
    this.offset += 1;
    return val;
  }
  readU2() {
    const val = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return val;
  }
  readU4() {
    const val = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return val;
  }
  readBytes(length) {
    const bytes = new Uint8Array(this.view.buffer, this.offset, length);
    this.offset += length;
    return bytes;
  }
  skip(count) {
    this.offset += count;
  }
};
function isJavaClassBuffer(buf) {
  if (!buf || buf.length < 8) return false;
  return buf[0] === 202 && buf[1] === 254 && buf[2] === 186 && buf[3] === 190;
}
function decompileJavaClass(buffer, classNameFallback = "DecompiledClass") {
  try {
    if (!isJavaClassBuffer(buffer)) {
      return `// Not a valid Java class file (missing CAFEBABE magic header)
`;
    }
    const reader = new ByteReader(buffer);
    const magic = reader.readU4();
    if (magic !== 3405691582) {
      return `// Invalid magic header: 0x${magic.toString(16)}
`;
    }
    const minorVersion = reader.readU2();
    const majorVersion = reader.readU2();
    const constantPoolCount = reader.readU2();
    const cp = new Array(constantPoolCount).fill(null);
    for (let i = 1; i < constantPoolCount; i++) {
      const tag = reader.readU1();
      switch (tag) {
        case CONSTANT_Utf8: {
          const len = reader.readU2();
          const bytes = reader.readBytes(len);
          const str = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
          cp[i] = { tag, value: str };
          break;
        }
        case CONSTANT_Integer:
          cp[i] = { tag, value: reader.readU4() };
          break;
        case CONSTANT_Float:
          cp[i] = { tag, value: reader.readU4() };
          break;
        case CONSTANT_Long:
          reader.skip(8);
          cp[i] = { tag, value: "long" };
          i++;
          break;
        case CONSTANT_Double:
          reader.skip(8);
          cp[i] = { tag, value: "double" };
          i++;
          break;
        case CONSTANT_Class:
          cp[i] = { tag, nameIndex: reader.readU2() };
          break;
        case CONSTANT_String:
          cp[i] = { tag, stringIndex: reader.readU2() };
          break;
        case CONSTANT_Fieldref:
        case CONSTANT_Methodref:
        case CONSTANT_InterfaceMethodref:
          cp[i] = {
            tag,
            classIndex: reader.readU2(),
            nameAndTypeIndex: reader.readU2()
          };
          break;
        case CONSTANT_NameAndType:
          cp[i] = {
            tag,
            nameIndex: reader.readU2(),
            descriptorIndex: reader.readU2()
          };
          break;
        case CONSTANT_MethodHandle:
          reader.skip(3);
          cp[i] = { tag };
          break;
        case CONSTANT_MethodType:
          reader.skip(2);
          cp[i] = { tag };
          break;
        case CONSTANT_Dynamic:
        case CONSTANT_InvokeDynamic:
          reader.skip(4);
          cp[i] = { tag };
          break;
        case CONSTANT_Module:
        case CONSTANT_Package:
          reader.skip(2);
          cp[i] = { tag };
          break;
        default:
          break;
      }
    }
    const getUtf8 = (idx) => {
      const entry = cp[idx];
      return entry && entry.tag === CONSTANT_Utf8 ? entry.value : "";
    };
    const getClassName = (classIdx) => {
      const entry = cp[classIdx];
      if (entry && entry.tag === CONSTANT_Class) {
        return getUtf8(entry.nameIndex).replace(/\//g, ".");
      }
      return "";
    };
    const accessFlags = reader.readU2();
    const thisClassIdx = reader.readU2();
    const superClassIdx = reader.readU2();
    const fullClassName = getClassName(thisClassIdx) || classNameFallback;
    const superClassName = getClassName(superClassIdx);
    const interfacesCount = reader.readU2();
    const interfaces = [];
    for (let i = 0; i < interfacesCount; i++) {
      const ifaceIdx = reader.readU2();
      const ifaceName = getClassName(ifaceIdx);
      if (ifaceName) interfaces.push(ifaceName);
    }
    const javaVersionMap = {
      49: "Java 5",
      50: "Java 6",
      51: "Java 7",
      52: "Java 8",
      53: "Java 9",
      54: "Java 10",
      55: "Java 11",
      56: "Java 12",
      57: "Java 13",
      58: "Java 14",
      59: "Java 15",
      60: "Java 16",
      61: "Java 17",
      62: "Java 18",
      63: "Java 19",
      64: "Java 20",
      65: "Java 21",
      66: "Java 22",
      67: "Java 23"
    };
    const javaVersionStr = javaVersionMap[majorVersion] || `class version ${majorVersion}.${minorVersion}`;
    const fieldsCount = reader.readU2();
    const fields = [];
    for (let i = 0; i < fieldsCount; i++) {
      const fFlags = reader.readU2();
      const fName = getUtf8(reader.readU2());
      const fDesc = getUtf8(reader.readU2());
      const attrCount = reader.readU2();
      let fSig;
      for (let a = 0; a < attrCount; a++) {
        const attrName = getUtf8(reader.readU2());
        const attrLen = reader.readU4();
        if (attrName === "Signature" && attrLen === 2) {
          fSig = getUtf8(reader.readU2());
        } else {
          reader.skip(attrLen);
        }
      }
      fields.push({ accessFlags: fFlags, name: fName, descriptor: fDesc, signature: fSig });
    }
    const methodsCount = reader.readU2();
    const methods = [];
    for (let i = 0; i < methodsCount; i++) {
      const mFlags = reader.readU2();
      const mName = getUtf8(reader.readU2());
      const mDesc = getUtf8(reader.readU2());
      const attrCount = reader.readU2();
      let mSig;
      let instructions = [];
      for (let a = 0; a < attrCount; a++) {
        const attrName = getUtf8(reader.readU2());
        const attrLen = reader.readU4();
        if (attrName === "Signature" && attrLen === 2) {
          mSig = getUtf8(reader.readU2());
        } else if (attrName === "Code") {
          const maxStack = reader.readU2();
          const maxLocals = reader.readU2();
          const codeLen = reader.readU4();
          const codeBytes = reader.readBytes(codeLen);
          instructions = disassembleBytecode(codeBytes, cp, getUtf8, getClassName);
          const exceptionTableLen = reader.readU2();
          reader.skip(exceptionTableLen * 8);
          const codeAttrCount = reader.readU2();
          for (let ca = 0; ca < codeAttrCount; ca++) {
            reader.readU2();
            const caLen = reader.readU4();
            reader.skip(caLen);
          }
        } else {
          reader.skip(attrLen);
        }
      }
      methods.push({
        accessFlags: mFlags,
        name: mName,
        descriptor: mDesc,
        signature: mSig,
        instructions
      });
    }
    const classAttrCount = reader.readU2();
    let classSignature;
    for (let a = 0; a < classAttrCount; a++) {
      const attrName = getUtf8(reader.readU2());
      const attrLen = reader.readU4();
      if (attrName === "Signature" && attrLen === 2) {
        classSignature = getUtf8(reader.readU2());
      } else {
        reader.skip(attrLen);
      }
    }
    return formatJavaSource({
      fullClassName,
      superClassName,
      interfaces,
      accessFlags,
      fields,
      methods,
      javaVersionStr,
      classSignature
    });
  } catch (err) {
    return `// Decompiler error: ${err.message || "Failed to parse class file"}
`;
  }
}
function parseFieldDescriptor(desc) {
  if (!desc) return "void";
  if (desc === "Z") return "boolean";
  if (desc === "B") return "byte";
  if (desc === "C") return "char";
  if (desc === "S") return "short";
  if (desc === "I") return "int";
  if (desc === "J") return "long";
  if (desc === "F") return "float";
  if (desc === "D") return "double";
  if (desc === "V") return "void";
  if (desc.startsWith("[")) {
    return parseFieldDescriptor(desc.substring(1)) + "[]";
  }
  if (desc.startsWith("L") && desc.endsWith(";")) {
    const raw = desc.substring(1, desc.length - 1).replace(/\//g, ".");
    return cleanTypeName(raw);
  }
  return desc;
}
function cleanTypeName(full) {
  if (full.startsWith("java.lang.") && full.split(".").length === 3) {
    return full.substring(10);
  }
  return full;
}
function parseMethodDescriptor(desc) {
  const match = desc.match(/^\((.*?)\)(.*)$/);
  if (!match) return { params: [], returnType: "void" };
  const rawParams = match[1];
  const rawRet = match[2];
  const params = [];
  let idx = 0;
  while (idx < rawParams.length) {
    let arrDim = 0;
    while (rawParams[idx] === "[") {
      arrDim++;
      idx++;
    }
    const ch = rawParams[idx];
    if (ch === "L") {
      const end = rawParams.indexOf(";", idx);
      if (end === -1) break;
      const type = rawParams.substring(idx + 1, end).replace(/\//g, ".");
      params.push(cleanTypeName(type) + "[]".repeat(arrDim));
      idx = end + 1;
    } else {
      const primitive = parseFieldDescriptor(ch);
      params.push(primitive + "[]".repeat(arrDim));
      idx++;
    }
  }
  return {
    params,
    returnType: cleanTypeName(parseFieldDescriptor(rawRet))
  };
}
function formatAccessFlags(flags, isClass = false, isInterface = false) {
  const parts = [];
  if (flags & ACC_PUBLIC) parts.push("public");
  if (flags & ACC_PROTECTED) parts.push("protected");
  if (flags & ACC_PRIVATE) parts.push("private");
  if (flags & ACC_ABSTRACT && !isInterface) parts.push("abstract");
  if (flags & ACC_STATIC) parts.push("static");
  if (flags & ACC_FINAL) parts.push("final");
  if (flags & ACC_SYNCHRONIZED) parts.push("synchronized");
  if (flags & ACC_NATIVE) parts.push("native");
  if (flags & ACC_VOLATILE) parts.push("volatile");
  if (flags & ACC_TRANSIENT) parts.push("transient");
  return parts.join(" ");
}
function disassembleBytecode(code, cp, getUtf8, getClassName) {
  const statements = [];
  let i = 0;
  const getNameAndType = (idx) => {
    const entry = cp[idx];
    if (entry && entry.tag === CONSTANT_NameAndType) {
      return {
        name: getUtf8(entry.nameIndex),
        descriptor: getUtf8(entry.descriptorIndex)
      };
    }
    return { name: "", descriptor: "" };
  };
  const getMemberRef = (idx) => {
    const entry = cp[idx];
    if (entry && (entry.tag === CONSTANT_Methodref || entry.tag === CONSTANT_Fieldref || entry.tag === CONSTANT_InterfaceMethodref)) {
      const owner = getClassName(entry.classIndex);
      const nt = getNameAndType(entry.nameAndTypeIndex);
      return { owner, name: nt.name, descriptor: nt.descriptor };
    }
    return { owner: "", name: "", descriptor: "" };
  };
  while (i < code.length) {
    const op = code[i];
    switch (op) {
      case 0:
        i++;
        break;
      case 1:
        statements.push("// push null");
        i++;
        break;
      case 178:
      // getstatic
      case 180: {
        const refIdx = code[i + 1] << 8 | code[i + 2];
        const member = getMemberRef(refIdx);
        const prefix = op === 178 ? member.owner : "this";
        statements.push(`// access ${prefix}.${member.name} (${cleanTypeName(parseFieldDescriptor(member.descriptor))})`);
        i += 3;
        break;
      }
      case 179:
      // putstatic
      case 181: {
        const refIdx = code[i + 1] << 8 | code[i + 2];
        const member = getMemberRef(refIdx);
        const prefix = op === 179 ? member.owner : "this";
        statements.push(`// assign ${prefix}.${member.name}`);
        i += 3;
        break;
      }
      case 182:
      // invokevirtual
      case 183:
      // invokespecial
      case 184:
      // invokestatic
      case 185: {
        const refIdx = code[i + 1] << 8 | code[i + 2];
        const member = getMemberRef(refIdx);
        const callType = op === 184 ? "static call" : op === 183 ? "special call" : "call";
        statements.push(`${callType} ${member.owner}.${member.name}(...);`);
        i += op === 185 ? 5 : 3;
        break;
      }
      case 18: {
        const cIdx = code[i + 1];
        const cEntry = cp[cIdx];
        if (cEntry && cEntry.tag === CONSTANT_String) {
          const s = getUtf8(cEntry.stringIndex);
          statements.push(`// load string "${s.length > 50 ? s.slice(0, 47) + "..." : s}"`);
        }
        i += 2;
        break;
      }
      case 187: {
        const classIdx = code[i + 1] << 8 | code[i + 2];
        const clsName = getClassName(classIdx);
        statements.push(`new ${clsName}();`);
        i += 3;
        break;
      }
      case 172:
      // ireturn
      case 173:
      // lreturn
      case 174:
      // freturn
      case 175:
      // dreturn
      case 176:
        statements.push("return result;");
        i++;
        break;
      case 177:
        statements.push("return;");
        i++;
        break;
      case 191:
        statements.push("throw exception;");
        i++;
        break;
      default:
        i++;
        break;
    }
  }
  const cleaned = [];
  let lastWasComment = false;
  for (const s of statements) {
    if (s.startsWith("//")) {
      if (!lastWasComment) cleaned.push(s);
      lastWasComment = true;
    } else {
      cleaned.push(s);
      lastWasComment = false;
    }
  }
  return cleaned.slice(0, 20);
}
function formatJavaSource(info) {
  const parts = info.fullClassName.split(".");
  const simpleName = parts.pop() || "Unknown";
  const packageName = parts.join(".");
  const isInterface = Boolean(info.accessFlags & ACC_INTERFACE);
  const isEnum = Boolean(info.accessFlags & ACC_ENUM);
  const kind = isInterface ? "interface" : isEnum ? "enum" : "class";
  const lines = [];
  lines.push(`// Decompiled from Java .class bytecode (${info.javaVersionStr})`);
  lines.push(`// Source: ${info.fullClassName}`);
  lines.push("");
  if (packageName) {
    lines.push(`package ${packageName};`);
    lines.push("");
  }
  const classModifier = formatAccessFlags(info.accessFlags, true, isInterface);
  let decl = `${classModifier ? classModifier + " " : ""}${kind} ${simpleName}`;
  if (info.superClassName && info.superClassName !== "java.lang.Object" && !isInterface && !isEnum) {
    decl += ` extends ${info.superClassName}`;
  }
  if (info.interfaces.length > 0) {
    decl += ` ${isInterface ? "extends" : "implements"} ${info.interfaces.join(", ")}`;
  }
  decl += " {";
  lines.push(decl);
  if (info.fields.length > 0) {
    for (const f of info.fields) {
      const fMods = formatAccessFlags(f.accessFlags);
      const fType = cleanTypeName(parseFieldDescriptor(f.descriptor));
      lines.push(`    ${fMods ? fMods + " " : ""}${fType} ${f.name};`);
    }
    lines.push("");
  }
  for (const m of info.methods) {
    const isInit = m.name === "<init>";
    const isClinit = m.name === "<clinit>";
    if (isClinit) {
      lines.push("    static {");
      if (m.instructions && m.instructions.length > 0) {
        for (const inst of m.instructions) {
          lines.push(`        ${inst}`);
        }
      }
      lines.push("    }");
      lines.push("");
      continue;
    }
    const mMods = formatAccessFlags(m.accessFlags);
    const { params, returnType } = parseMethodDescriptor(m.descriptor);
    const mName = isInit ? simpleName : m.name;
    const mRet = isInit ? "" : returnType + " ";
    const paramStr = params.map((p, idx) => `${p} arg${idx}`).join(", ");
    const isAbstract = Boolean(m.accessFlags & ACC_ABSTRACT) || isInterface;
    if (isAbstract) {
      lines.push(`    ${mMods ? mMods + " " : ""}${mRet}${mName}(${paramStr});`);
    } else {
      lines.push(`    ${mMods ? mMods + " " : ""}${mRet}${mName}(${paramStr}) {`);
      if (m.instructions && m.instructions.length > 0) {
        for (const inst of m.instructions) {
          lines.push(`        ${inst}`);
        }
      } else {
        lines.push("        // [Compiled method body]");
      }
      lines.push("    }");
    }
    lines.push("");
  }
  lines.push("}");
  return lines.join("\n");
}

// server.ts
import { createServer as createViteServer } from "vite";
dotenv.config();
var rawExecFileAsync = promisify(execFile);
var execFileAsync = async (file, args, options = {}) => {
  const result = await rawExecFileAsync(file, args, {
    windowsHide: true,
    encoding: "utf8",
    ...options,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...options.env || {}
    }
  });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : result.stdout?.toString("utf8") || "",
    stderr: typeof result.stderr === "string" ? result.stderr : result.stderr?.toString("utf8") || ""
  };
};
var fsPromises = fs.promises;
var app = express();
var PORT = process.env.PORT || 3e3;
app.use(express.json({ limit: "50mb" }));
function sanitizeSubpath(subpath) {
  return subpath.replace(/\.\./g, "").replace(/^\/+|\/+$/g, "");
}
function formatTokenCount(tokens) {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}k`;
  return `${tokens}`;
}
var OWNER_GITHUB_LOGIN = (process.env.OWNER_GITHUB_LOGIN || "honeypie3301").toLowerCase();
var OWNER_GITHUB_ID = process.env.OWNER_GITHUB_ID ? Number(process.env.OWNER_GITHUB_ID) : 84184414;
var OWNER_ACCESS_KEY = (process.env.OWNER_ACCESS_KEY || process.env.OWNER_PASSPHRASE || "honeypie3301-84184414").trim();
var OWNER_REPO_NAME = (process.env.OWNER_REPO_NAME || "Personal-Gitingest").trim();
var tokenCache = /* @__PURE__ */ new Map();
var TOKEN_CACHE_TTL = 10 * 60 * 1e3;
var rateLimits = /* @__PURE__ */ new Map();
function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const entry = rateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) {
    return false;
  }
  entry.count++;
  return true;
}
async function verifyOwnerCredentials(tokenOrKey) {
  if (!tokenOrKey || !tokenOrKey.trim()) {
    return { authorized: false, reason: "No authorization credentials provided." };
  }
  let clean = tokenOrKey.trim();
  clean = clean.replace(/^["']|["']$/g, "").trim();
  clean = clean.replace(/^(bearer|token)\s+/i, "").trim();
  if (OWNER_ACCESS_KEY && clean === OWNER_ACCESS_KEY) {
    return {
      authorized: true,
      user: {
        login: OWNER_GITHUB_LOGIN,
        id: OWNER_GITHUB_ID,
        name: "Owner",
        avatar_url: ""
      }
    };
  }
  const cached = tokenCache.get(clean);
  const now = Date.now();
  if (cached && cached.isOwner && now - cached.cachedAt < TOKEN_CACHE_TTL) {
    return { authorized: true, user: cached.user };
  }
  try {
    let ghRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `token ${clean}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "GitIngest-OwnerAuth"
      },
      signal: AbortSignal.timeout(3e3)
    });
    if (!ghRes.ok && ghRes.status === 401) {
      ghRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${clean}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "GitIngest-OwnerAuth"
        },
        signal: AbortSignal.timeout(3e3)
      });
    }
    if (ghRes.status === 429 || ghRes.status === 403 && ghRes.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(ghRes.headers.get("x-ratelimit-reset"));
      return { authorized: false, status: 429, reason: `GitHub API rate limit exceeded.${reset ? ` Retry after ${new Date(reset * 1e3).toISOString()}.` : " Retry after the rate limit resets."}` };
    }
    if (!ghRes.ok && (ghRes.status === 403 || ghRes.status === 404)) {
      try {
        const userReposRes = await fetch("https://api.github.com/user/repos?per_page=10&affiliation=owner&sort=updated", {
          headers: {
            Authorization: `Bearer ${clean}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "GitIngest-OwnerAuth"
          }
        });
        if (userReposRes.ok) {
          const repos = await userReposRes.json();
          if (Array.isArray(repos) && repos.length > 0) {
            const matchedRepo = repos.find((r) => r.owner) || repos[0];
            if (matchedRepo?.owner) {
              const user = {
                id: matchedRepo.owner.id,
                login: matchedRepo.owner.login,
                avatar_url: matchedRepo.owner.avatar_url || "",
                name: matchedRepo.owner.login,
                html_url: matchedRepo.owner.html_url
              };
              const isOwner = matchedRepo.owner.login.toLowerCase() === OWNER_GITHUB_LOGIN;
              tokenCache.set(clean, { isOwner, user, cachedAt: now });
              return { authorized: true, user };
            }
          }
        }
      } catch {
      }
      const candidateRepos = Array.from(/* @__PURE__ */ new Set([OWNER_REPO_NAME, "Personal-Gitingest", "Gitingest", "gitingest"]));
      for (const repoName of candidateRepos) {
        try {
          const repoCheck = await fetch(`https://api.github.com/repos/${OWNER_GITHUB_LOGIN}/${repoName}`, {
            headers: {
              Authorization: `Bearer ${clean}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "GitIngest-OwnerAuth"
            }
          });
          if (repoCheck.ok) {
            const repoData = await repoCheck.json();
            if (repoData.owner) {
              const user = {
                id: repoData.owner.id,
                login: repoData.owner.login,
                avatar_url: repoData.owner.avatar_url || "",
                name: repoData.owner.login,
                html_url: repoData.owner.html_url
              };
              const isOwner = repoData.owner.login.toLowerCase() === OWNER_GITHUB_LOGIN;
              tokenCache.set(clean, { isOwner, user, cachedAt: now });
              return { authorized: true, user };
            }
          }
        } catch {
        }
      }
    }
    if (!ghRes.ok) {
      const errText = await ghRes.text().catch(() => "");
      let errMsg = `GitHub API (${ghRes.status})`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.message) {
          errMsg += `: ${parsed.message}`;
          if (parsed.message.includes("Bad credentials")) {
            errMsg += " \u2014 please check that the token is active and was copied completely.";
          } else if (parsed.message.includes("Resource not accessible")) {
            errMsg += ` \u2014 if using a Fine-Grained PAT, ensure repository access is granted in GitHub PAT settings.`;
          }
        }
      } catch {
        if (errText) errMsg += `: ${errText.slice(0, 100)}`;
      }
      return { authorized: false, reason: errMsg };
    }
    const userData = await ghRes.json();
    if (userData && userData.login) {
      const user = {
        id: userData.id,
        node_id: userData.node_id,
        login: userData.login,
        avatar_url: userData.avatar_url,
        name: userData.name || userData.login,
        html_url: userData.html_url
      };
      const isOwner = userData.login.toLowerCase() === OWNER_GITHUB_LOGIN;
      tokenCache.set(clean, { isOwner, user, cachedAt: now });
      return { authorized: true, user };
    }
    return {
      authorized: false,
      reason: "Invalid GitHub user data returned by API."
    };
  } catch (err) {
    return { authorized: false, reason: `Failed to verify token: ${err.message}` };
  }
}
app.post("/api/verify-auth", async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(`auth:${ip}`, 10, 5 * 60 * 1e3)) {
    return res.status(429).json({ error: "Too many authentication attempts. Please try again in 5 minutes." });
  }
  const { auth } = req.body || {};
  if (!auth || typeof auth !== "string") {
    return res.status(400).json({ error: "Authentication token or access key required" });
  }
  const check = await verifyOwnerCredentials(auth);
  if (check.authorized) {
    return res.json({ success: true, user: check.user });
  }
  return res.status(check.status || 401).json({ success: false, error: check.reason || "Invalid credentials" });
});
app.get("/api/user-status", async (req, res) => {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
  if (!bearerToken) {
    return res.json({ configured: false, user: null, authorized: false });
  }
  const check = await verifyOwnerCredentials(bearerToken);
  return res.json({
    configured: check.authorized,
    authorized: check.authorized,
    user: check.user || null
  });
});
app.all("/api/ingest/jobs/:id", handleWorkerJob);
app.post("/api/ingest", async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(`ingest:${ip}`, 30, 60 * 1e3)) {
    return res.status(429).json({ error: "Rate limit exceeded: max 30 ingestions per minute." });
  }
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
  const incomingToken = bearerToken || req.body.token || process.env.GITHUB_TOKEN;
  const acceptHeader = (req.headers.accept || "").toLowerCase();
  const isNdjson = !process.env.INGEST_WORKER_URL && !req.headers["x-no-stream"] && (!acceptHeader || acceptHeader.includes("application/x-ndjson") || acceptHeader.includes("*/*") || acceptHeader.includes("text/event-stream"));
  if (isNdjson) {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
    if (res.socket) {
      res.socket.setNoDelay(true);
    }
    res.flushHeaders?.();
  }
  const sendProgress = (filePath, count, total, status) => {
    if (isNdjson && !res.writableEnded) {
      try {
        const cleanPath = filePath.replace(/\s*\[Decompiled Java\]$/i, "");
        const jsonLine = JSON.stringify({ type: "progress", path: cleanPath, count, total, status }) + "\n";
        res.cork();
        res.write(jsonLine);
        res.uncork();
      } catch {
      }
    }
  };
  const sendResult = (data) => {
    if (isNdjson) {
      if (!res.writableEnded) {
        res.write(JSON.stringify({ type: "result", data }) + "\n");
        res.end();
      }
    } else {
      res.json(data);
    }
  };
  const { input_text, max_file_size = 50, pattern_type = "exclude", pattern = "", token, decompile_classes = false } = req.body;
  if (!input_text || typeof input_text !== "string") {
    return res.status(400).json({ error: "Please provide a valid repository URL or path" });
  }
  if (process.env.INGEST_WORKER_URL) return submitWorkerJob(req, res);
  const activeToken = (bearerToken || token || process.env.GITHUB_TOKEN || "").trim();
  const patterns = pattern.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean);
  const compiledPatterns = patterns.map((pat) => {
    const escaped = pat.replace(/\./g, "\\.").replace(/\*/g, ".*");
    try {
      return { regex: new RegExp(escaped, "i"), raw: pat };
    } catch {
      return { regex: null, raw: pat };
    }
  });
  const isPathAllowed = (relPath) => {
    if (compiledPatterns.length === 0) return true;
    const matched = compiledPatterns.some(({ regex, raw }) => regex ? regex.test(relPath) : relPath.includes(raw));
    return pattern_type === "include" ? matched : !matched;
  };
  const maxBytes = max_file_size * 1024 * 1024;
  const potentialLocalPath = input_text.trim();
  if (fs.existsSync(potentialLocalPath)) {
    try {
      const stats = fs.statSync(potentialLocalPath);
      if (stats.isDirectory()) {
        let walkLocalDir = function(currentDir) {
          let entries;
          try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".venv" || entry.name === "$RECYCLE.BIN") continue;
            const full = path.join(currentDir, entry.name);
            const rel = path.relative(localRoot, full).replace(/\\/g, "/");
            try {
              if (entry.isDirectory()) {
                walkLocalDir(full);
              } else if (entry.isFile()) {
                if (!isPathAllowed(rel)) continue;
                try {
                  const stat = fs.statSync(full);
                  if (stat.size <= maxBytes) {
                    collectedFiles.push({ relPath: rel, fullPath: full, size: stat.size });
                  }
                } catch {
                }
              }
            } catch {
            }
          }
        };
        const localRoot = path.resolve(potentialLocalPath);
        const collectedFiles = [];
        walkLocalDir(localRoot);
        const paths = collectedFiles.map((f) => f.relPath);
        const treeText = buildAsciiTree(path.basename(localRoot), paths);
        const fileContents = [];
        let totalChars = 0;
        const MAX_LOCAL_DIGEST_CHARS = 40 * 1024 * 1024;
        let isLocalTruncated = false;
        for (const file of collectedFiles) {
          if (totalChars >= MAX_LOCAL_DIGEST_CHARS) {
            isLocalTruncated = true;
            break;
          }
          try {
            const buf = fs.readFileSync(file.fullPath);
            if (buf.length > maxBytes) continue;
            let content;
            let fileHeader = file.relPath;
            if (file.relPath.toLowerCase().endsWith(".class")) {
              if (decompile_classes) {
                content = await decompileJavaClass(buf, path.basename(file.relPath, ".class"));
                fileHeader += " [Decompiled Java]";
              } else {
                content = "[Binary file: Java Class file]";
              }
            } else if (isBinaryBuffer(buf)) {
              content = "[Binary file]";
            } else {
              content = buf.toString("utf-8");
            }
            totalChars += content.length;
            fileContents.push(
              `================================================
File: ${fileHeader}
================================================
${content}
`
            );
            const isClass = fileHeader.includes("[Decompiled Java]");
            const isBin = content.startsWith("[Binary file");
            sendProgress(
              fileHeader,
              fileContents.length,
              collectedFiles.length,
              isClass ? "decompiling" : isBin ? "binary" : "completed"
            );
          } catch {
          }
        }
        if (isLocalTruncated) {
          fileContents.push(`
[Notice: Digest capped at 40MB for browser rendering stability. Use pattern filters for targeted ingestion.]
`);
        }
        const estimatedTokens = formatTokenCount(Math.round(totalChars / 4));
        const summary = [
          `Local Directory: ${localRoot}`,
          `Files analyzed: ${fileContents.length}`,
          `Estimated tokens: ${estimatedTokens}`,
          `Total characters: ${totalChars.toLocaleString()}`,
          isLocalTruncated ? `(Digest capped at 40MB for stability)` : null
        ].filter(Boolean).join("\n");
        const responsePayload = {
          summary,
          tree: `Directory structure:
${treeText}`,
          content: fileContents.join("\n"),
          repo_name: path.basename(localRoot),
          files_analyzed: fileContents.length,
          estimated_tokens: estimatedTokens,
          total_chars: totalChars,
          mode_info: "Local Directory (Offline, 0 Network Calls)"
        };
        if (typeof global.gc === "function") {
          setImmediate(() => {
            try {
              global.gc();
            } catch {
            }
          });
        }
        return sendResult(responsePayload);
      }
    } catch (err) {
      console.error("Local directory read error:", err);
    }
  }
  let clean = input_text.trim();
  let isSshUrl = false;
  if (/^git@github\.com:/i.test(clean)) {
    isSshUrl = true;
    clean = clean.replace(/^git@github\.com:/i, "");
  } else {
    clean = clean.replace(/^https?:\/\//i, "");
    clean = clean.replace(/^(?:www\.)?(?:github\.com|gitingest\.com)\//i, "");
  }
  clean = clean.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const parts = clean.split("/");
  if (parts.length < 2) {
    return res.status(400).json({ error: "Invalid URL. Expected format: owner/repo or https://github.com/owner/repo" });
  }
  const owner = parts[0];
  const repo = parts[1];
  let branch;
  let subpath;
  if (parts.length > 3 && (parts[2] === "tree" || parts[2] === "blob")) {
    branch = parts[3];
    if (parts.length > 4) {
      subpath = sanitizeSubpath(parts.slice(4).join("/"));
    }
  }
  const abortController = new AbortController();
  let clientDisconnected = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      abortController.abort();
    }
  });
  let wasRateLimited = false;
  try {
    sendProgress(`Connecting to ${owner}/${repo}...`, 0, void 0, "ingesting");
    let resolvedBranch = branch || "";
    let zipRes;
    const zipHeaders = {
      "User-Agent": "GitIngest-Fast"
    };
    if (activeToken) zipHeaders.Authorization = `Bearer ${activeToken}`;
    sendProgress(`Downloading zipball archive for ${owner}/${repo}...`, 0, void 0, "ingesting");
    if (resolvedBranch) {
      zipRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/zipball/${encodeURIComponent(resolvedBranch)}`, {
        headers: zipHeaders,
        signal: abortController.signal
      });
      if (zipRes && (zipRes.status === 403 || zipRes.status === 429)) {
        wasRateLimited = true;
      }
    } else {
      const repoHeaders = {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "GitIngest-Fast"
      };
      if (activeToken) repoHeaders.Authorization = `Bearer ${activeToken}`;
      const [repoMetaRes, zipMainRes] = await Promise.all([
        fetch(`https://api.github.com/repos/${owner}/${repo}`, {
          headers: repoHeaders,
          signal: abortController.signal
        }),
        fetch(`https://api.github.com/repos/${owner}/${repo}/zipball/main`, {
          headers: zipHeaders,
          signal: abortController.signal
        }).catch(() => null)
      ]);
      if (repoMetaRes.status === 403 || repoMetaRes.status === 429) {
        wasRateLimited = true;
      }
      if (repoMetaRes.ok) {
        const repoMetaData = await repoMetaRes.json();
        resolvedBranch = repoMetaData.default_branch || "main";
      } else {
        resolvedBranch = "main";
      }
      if (resolvedBranch === "main" && zipMainRes && zipMainRes.ok) {
        zipRes = zipMainRes;
      } else {
        zipRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/zipball/${encodeURIComponent(resolvedBranch)}`, {
          headers: zipHeaders,
          signal: abortController.signal
        });
        if (zipRes && (zipRes.status === 403 || zipRes.status === 429)) {
          wasRateLimited = true;
        }
      }
    }
    if (zipRes && zipRes.ok) {
      sendProgress(`Archive downloaded. Extracting and analyzing repository...`, 0, void 0, "ingesting");
      const arrayBuf = await zipRes.arrayBuffer();
      if (arrayBuf.byteLength > 0 && arrayBuf.byteLength < 300 * 1024 * 1024) {
        const zip = await JSZip.loadAsync(arrayBuf);
        const fileKeys = Object.keys(zip.files);
        const firstKey = fileKeys[0] || "";
        const rootPrefix = firstKey.includes("/") ? firstKey.split("/")[0] + "/" : "";
        const fileEntries = [];
        const allPaths = [];
        for (const rawPath of fileKeys) {
          const obj = zip.files[rawPath];
          if (obj.dir) continue;
          const relPath = rootPrefix && rawPath.startsWith(rootPrefix) ? rawPath.substring(rootPrefix.length) : rawPath;
          if (!relPath || relPath.startsWith(".git/")) continue;
          if (subpath && !relPath.startsWith(subpath)) continue;
          if (!isPathAllowed(relPath)) continue;
          allPaths.push(relPath);
          fileEntries.push({ relPath, obj });
        }
        const treeText = buildAsciiTree(subpath || repo, allPaths);
        const fileContents = [];
        let totalChars = 0;
        const MAX_ZIP_DIGEST_CHARS = 40 * 1024 * 1024;
        let isZipTruncated = false;
        const ZIP_CHUNK = 4;
        for (let i = 0; i < fileEntries.length; i += ZIP_CHUNK) {
          if (clientDisconnected) return;
          if (totalChars >= MAX_ZIP_DIGEST_CHARS) {
            isZipTruncated = true;
            break;
          }
          const chunk = fileEntries.slice(i, i + ZIP_CHUNK);
          const chunkResults = await Promise.all(
            chunk.map(async ({ relPath, obj }) => {
              try {
                let content;
                let fileHeader = relPath;
                if (relPath.toLowerCase().endsWith(".class")) {
                  const buf = await obj.async("nodebuffer");
                  if (decompile_classes) {
                    content = await decompileJavaClass(buf, path.basename(relPath, ".class"));
                    fileHeader += " [Decompiled Java]";
                  } else {
                    content = "[Binary file: Java Class file]";
                  }
                } else {
                  const buf = await obj.async("nodebuffer");
                  if (buf.length > maxBytes) return null;
                  if (isBinaryBuffer(buf)) {
                    content = "[Binary file]";
                  } else {
                    content = buf.toString("utf-8");
                  }
                }
                return { relPath: fileHeader, content, len: content.length };
              } catch {
                return null;
              }
            })
          );
          for (const item of chunkResults) {
            if (item) {
              totalChars += item.len;
              fileContents.push(
                `================================================
File: ${item.relPath}
================================================
${item.content}
`
              );
              const isClass = item.relPath.includes("[Decompiled Java]");
              const isBin = item.content.startsWith("[Binary file");
              sendProgress(
                item.relPath,
                fileContents.length,
                fileEntries.length,
                isClass ? "decompiling" : isBin ? "binary" : "completed"
              );
              if (totalChars >= MAX_ZIP_DIGEST_CHARS) {
                isZipTruncated = true;
                break;
              }
            }
          }
        }
        if (isZipTruncated) {
          fileContents.push(`
[Notice: Codebase digest capped at 40MB for browser rendering stability. Use subpaths or pattern filters for targeted ingestion.]
`);
        }
        const estimatedTokens = formatTokenCount(Math.round(totalChars / 4));
        const summaryParts = [
          `Repository: ${owner}/${repo}`,
          resolvedBranch ? `Branch: ${resolvedBranch}` : null,
          subpath ? `Subpath: ${subpath}` : null,
          `Files analyzed: ${fileContents.length}`,
          `Estimated tokens: ${estimatedTokens}`,
          `Total characters: ${totalChars.toLocaleString()}`,
          isZipTruncated ? `(Digest capped at 40MB for browser rendering stability)` : null
        ].filter(Boolean);
        return sendResult({
          summary: summaryParts.join("\n"),
          tree: `Directory structure:
${treeText}`,
          content: fileContents.join("\n"),
          repo_name: `${owner}/${repo}`,
          subpath: subpath || void 0,
          files_analyzed: fileContents.length,
          estimated_tokens: estimatedTokens,
          total_chars: totalChars
        });
      }
    }
  } catch (zipErr) {
    if (clientDisconnected) return;
  }
  const tempDir = path.join(os.tmpdir(), `gitingest_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`);
  try {
    let effectiveToken = activeToken;
    if (!effectiveToken) {
      try {
        const { stdout: ghToken } = await execFileAsync("gh", ["auth", "token"], { timeout: 3e3 });
        if (ghToken && ghToken.trim()) {
          effectiveToken = ghToken.trim();
        }
      } catch {
      }
    }
    const cloneUrl = isSshUrl ? `git@github.com:${owner}/${repo}.git` : effectiveToken ? `https://x-access-token:${encodeURIComponent(effectiveToken)}@github.com/${owner}/${repo}.git` : `https://github.com/${owner}/${repo}.git`;
    const cloneArgs = [
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      "-c",
      "core.packedGitLimit=128m",
      "-c",
      "core.deltaBaseCacheLimit=128m"
    ];
    if (subpath) {
      cloneArgs.push("--filter=blob:none", "--no-checkout", "--sparse");
    }
    if (branch) {
      cloneArgs.push("-b", branch);
    }
    cloneArgs.push(cloneUrl, tempDir);
    try {
      await execFileAsync("git", cloneArgs, { timeout: 3e5 });
    } catch (gitErr) {
      let ghCloneSucceeded = false;
      try {
        const ghCloneArgs = ["repo", "clone", `${owner}/${repo}`, tempDir, "--", "--depth", "1", "--single-branch", "--no-tags"];
        if (branch) ghCloneArgs.push("-b", branch);
        await execFileAsync("gh", ghCloneArgs, { timeout: 3e5 });
        ghCloneSucceeded = true;
      } catch {
      }
      if (!ghCloneSucceeded) {
        const errMsg = gitErr.stderr || gitErr.message || "";
        if (errMsg.includes("could not read Username") || errMsg.includes("Authentication failed") || errMsg.includes("Repository not found")) {
          return res.status(403).json({
            error: `Could not access repository "${owner}/${repo}". If this is a private repository, please ensure your GitHub Personal Access Token is configured with 'repo' scope, or run 'gh auth login' locally.`
          });
        }
        const fallbackArgs = [
          "clone",
          "--depth",
          "1",
          "--single-branch",
          "--no-tags",
          "-c",
          "core.packedGitLimit=128m",
          "-c",
          "core.deltaBaseCacheLimit=128m"
        ];
        if (branch) fallbackArgs.push("-b", branch);
        fallbackArgs.push(cloneUrl, tempDir);
        await execFileAsync("git", fallbackArgs, { timeout: 3e5 });
      }
    }
    if (subpath) {
      try {
        await execFileAsync("git", ["-C", tempDir, "sparse-checkout", "set", subpath], { timeout: 3e4 });
        await execFileAsync("git", ["-C", tempDir, "checkout"], { timeout: 6e4 });
      } catch {
        try {
          await execFileAsync("git", ["-C", tempDir, "checkout"], { timeout: 6e4 });
        } catch {
        }
      }
    }
    const targetRoot = subpath ? path.join(tempDir, subpath) : tempDir;
    if (!fs.existsSync(targetRoot)) {
      return res.status(404).json({ error: `Subpath "${subpath}" does not exist in repository.` });
    }
    const collectedFiles = [];
    const PRUNED_DIR_NAMES = /* @__PURE__ */ new Set([
      ".git",
      "node_modules",
      ".venv",
      "venv",
      "dist",
      "build",
      "out",
      "target",
      ".next",
      ".nuxt",
      "coverage",
      ".cache",
      "vendor",
      "bin",
      "obj",
      ".gradle",
      ".idea",
      ".vscode",
      "__pycache__",
      ".turbo"
    ]);
    let usedGitLs = false;
    try {
      const { stdout: lsOut } = await execFileAsync("git", ["-C", targetRoot, "ls-files", "-z"], { timeout: 15e3 });
      const rawPaths = lsOut.split("\0").filter(Boolean);
      for (const rel of rawPaths) {
        if (!isPathAllowed(rel)) continue;
        const full = path.join(targetRoot, rel);
        try {
          const stat = await fsPromises.stat(full);
          if (stat.size <= maxBytes) {
            collectedFiles.push({ relPath: rel, fullPath: full, size: stat.size });
          }
        } catch {
        }
      }
      usedGitLs = true;
    } catch {
      usedGitLs = false;
    }
    if (!usedGitLs) {
      async function walkDirFast(currentDir) {
        const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
        await Promise.all(
          entries.map(async (entry) => {
            if (PRUNED_DIR_NAMES.has(entry.name)) return;
            const full = path.join(currentDir, entry.name);
            const rel = path.relative(targetRoot, full).replace(/\\/g, "/");
            if (entry.isDirectory()) {
              await walkDirFast(full);
            } else if (entry.isFile()) {
              if (!isPathAllowed(rel)) return;
              try {
                const stat = await fsPromises.stat(full);
                if (stat.size <= maxBytes) {
                  collectedFiles.push({ relPath: rel, fullPath: full, size: stat.size });
                }
              } catch {
              }
            }
          })
        );
      }
      await walkDirFast(targetRoot);
    }
    const paths = collectedFiles.map((f) => f.relPath);
    const treeText = buildAsciiTree(subpath || repo, paths);
    const CHUNK_SIZE = 2;
    const fileContents = [];
    let totalChars = 0;
    const MAX_DIGEST_CHARS = 40 * 1024 * 1024;
    let isTruncated = false;
    for (let i = 0; i < collectedFiles.length; i += CHUNK_SIZE) {
      if (clientDisconnected) return;
      if (totalChars >= MAX_DIGEST_CHARS) {
        isTruncated = true;
        break;
      }
      const chunk = collectedFiles.slice(i, i + CHUNK_SIZE);
      const readResults = await Promise.all(
        chunk.map(async (file) => {
          try {
            const buf = await fsPromises.readFile(file.fullPath);
            let content;
            let fileHeader = file.relPath;
            if (file.relPath.toLowerCase().endsWith(".class")) {
              if (decompile_classes) {
                content = await decompileJavaClass(buf, path.basename(file.relPath, ".class"));
                fileHeader += " [Decompiled Java]";
              } else {
                content = "[Binary file: Java Class file]";
              }
            } else if (isBinaryBuffer(buf)) {
              content = "[Binary file]";
            } else {
              content = buf.toString("utf-8");
            }
            return {
              relPath: fileHeader,
              content,
              length: content.length
            };
          } catch {
            return null;
          }
        })
      );
      for (const resItem of readResults) {
        if (resItem) {
          totalChars += resItem.length;
          fileContents.push(
            `================================================
File: ${resItem.relPath}
================================================
${resItem.content}
`
          );
          const isClass = resItem.relPath.includes("[Decompiled Java]");
          const isBin = resItem.content.startsWith("[Binary file");
          sendProgress(
            resItem.relPath,
            fileContents.length,
            collectedFiles.length,
            isClass ? "decompiling" : isBin ? "binary" : "completed"
          );
          if (totalChars >= MAX_DIGEST_CHARS) {
            isTruncated = true;
            break;
          }
        }
      }
    }
    if (isTruncated) {
      fileContents.push(`
[Notice: Codebase digest capped at 40MB for browser rendering stability. Use subpaths or pattern filters for targeted ingestion.]
`);
    }
    const fullContent = fileContents.join("\n");
    const estimatedTokens = formatTokenCount(Math.round(totalChars / 4));
    const summaryParts = [
      `Repository: ${owner}/${repo}`,
      branch ? `Branch: ${branch}` : null,
      subpath ? `Subpath: ${subpath}` : null,
      `Files analyzed: ${fileContents.length}`,
      `Estimated tokens: ${estimatedTokens}`,
      `Total characters: ${totalChars.toLocaleString()}`,
      isTruncated ? `(Digest capped at 40MB for browser rendering stability)` : null
    ].filter(Boolean);
    const summary = summaryParts.join("\n");
    return sendResult({
      summary,
      tree: `Directory structure:
${treeText}`,
      content: fullContent,
      repo_name: `${owner}/${repo}`,
      subpath: subpath || void 0,
      files_analyzed: fileContents.length,
      estimated_tokens: estimatedTokens,
      total_chars: totalChars,
      mode_switched: wasRateLimited,
      mode_info: wasRateLimited ? "Switched to Native Git CLI (Rate-limit bypassed)" : isSshUrl ? "Native Git CLI (SSH)" : void 0
    });
  } catch (err) {
    if (clientDisconnected) return;
    console.error("Ingestion error:", err);
    return res.status(500).json({ error: err.message || "Failed to process repository ingestion" });
  } finally {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (cleanErr) {
      console.error("Failed to cleanup temp dir:", cleanErr);
    }
    if (typeof global.gc === "function") {
      setImmediate(() => {
        try {
          global.gc();
        } catch {
        }
      });
    }
  }
});
function isBinaryBuffer(buf) {
  const maxBytes = Math.min(buf.length, 512);
  for (let i = 0; i < maxBytes; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
function buildAsciiTree(rootName, paths) {
  const root = {};
  for (const p of paths) {
    const parts = p.split("/");
    let curr = root;
    for (const part of parts) {
      if (!curr[part]) curr[part] = {};
      curr = curr[part];
    }
  }
  function render(node, prefix = "") {
    const keys = Object.keys(node).sort((a, b) => {
      const aIsDir = Object.keys(node[a]).length > 0;
      const bIsDir = Object.keys(node[b]).length > 0;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.localeCompare(b);
    });
    let result = "";
    keys.forEach((key, index) => {
      const isLast = index === keys.length - 1;
      const isDir = Object.keys(node[key]).length > 0;
      const connector = isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
      result += `${prefix}${connector}${key}${isDir ? "/" : ""}
`;
      if (isDir) {
        result += render(node[key], prefix + (isLast ? "    " : "\u2502   "));
      }
    });
    return result;
  }
  return `\u2514\u2500\u2500 ${rootName}/
${render(root, "    ")}`;
}
async function startServer() {
  try {
    const tmp = os.tmpdir();
    const files = await fsPromises.readdir(tmp);
    for (const f of files) {
      if (f.startsWith("gitingest_")) {
        await fsPromises.rm(path.join(tmp, f), { recursive: true, force: true }).catch(() => {
        });
      }
    }
  } catch {
  }
  const distPath = path.join(process.cwd(), "dist");
  const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const isSourceServer = /\.[cm]?tsx?$/i.test(entryPath);
  const isExplicitDev = process.env.NODE_ENV === "development" || isSourceServer;
  const hasDist = fs.existsSync(path.join(distPath, "index.html"));
  if (!isExplicitDev && hasDist) {
    app.use(express.static(distPath, { maxAge: "1d" }));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  }
  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`GitIngest server running on http://0.0.0.0:${PORT}`);
  });
}
startServer();
