/**
 * Pure TypeScript Java .class bytecode parser and decompiler.
 * Zero external dependencies. Works in Node.js and browser environments.
 */

interface ConstantPoolEntry {
  tag: number;
  [key: string]: any;
}

const CONSTANT_Utf8 = 1;
const CONSTANT_Integer = 3;
const CONSTANT_Float = 4;
const CONSTANT_Long = 5;
const CONSTANT_Double = 6;
const CONSTANT_Class = 7;
const CONSTANT_String = 8;
const CONSTANT_Fieldref = 9;
const CONSTANT_Methodref = 10;
const CONSTANT_InterfaceMethodref = 11;
const CONSTANT_NameAndType = 12;
const CONSTANT_MethodHandle = 15;
const CONSTANT_MethodType = 16;
const CONSTANT_Dynamic = 17;
const CONSTANT_InvokeDynamic = 18;
const CONSTANT_Module = 19;
const CONSTANT_Package = 20;

// Access flags
const ACC_PUBLIC = 0x0001;
const ACC_PRIVATE = 0x0002;
const ACC_PROTECTED = 0x0004;
const ACC_STATIC = 0x0008;
const ACC_FINAL = 0x0010;
const ACC_SYNCHRONIZED = 0x0020;
const ACC_VOLATILE = 0x0040;
const ACC_TRANSIENT = 0x0080;
const ACC_NATIVE = 0x0100;
const ACC_INTERFACE = 0x0200;
const ACC_ABSTRACT = 0x0400;
const ACC_STRICT = 0x0800;
const ACC_SYNTHETIC = 0x1000;
const ACC_ANNOTATION = 0x2000;
const ACC_ENUM = 0x4000;

class ByteReader {
  private view: DataView;
  private offset = 0;

  constructor(buffer: Uint8Array | Buffer) {
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    this.view = new DataView(ab);
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  readU1(): number {
    const val = this.view.getUint8(this.offset);
    this.offset += 1;
    return val;
  }

  readU2(): number {
    const val = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return val;
  }

  readU4(): number {
    const val = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return val;
  }

  readBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(this.view.buffer, this.offset, length);
    this.offset += length;
    return bytes;
  }

  skip(count: number): void {
    this.offset += count;
  }
}

export function isJavaClassBuffer(buf: Uint8Array | Buffer): boolean {
  if (!buf || buf.length < 8) return false;
  return buf[0] === 0xca && buf[1] === 0xfe && buf[2] === 0xba && buf[3] === 0xbe;
}

export function decompileJavaClass(buffer: Uint8Array | Buffer, classNameFallback = 'DecompiledClass'): string {
  try {
    if (!isJavaClassBuffer(buffer)) {
      return `// Not a valid Java class file (missing CAFEBABE magic header)\n`;
    }

    const reader = new ByteReader(buffer);
    const magic = reader.readU4();
    if (magic !== 0xcafebabe) {
      return `// Invalid magic header: 0x${magic.toString(16)}\n`;
    }

    const minorVersion = reader.readU2();
    const majorVersion = reader.readU2();

    const constantPoolCount = reader.readU2();
    const cp: (ConstantPoolEntry | null)[] = new Array(constantPoolCount).fill(null);

    // Constant Pool parsing
    for (let i = 1; i < constantPoolCount; i++) {
      const tag = reader.readU1();
      switch (tag) {
        case CONSTANT_Utf8: {
          const len = reader.readU2();
          const bytes = reader.readBytes(len);
          const str = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
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
          cp[i] = { tag, value: 'long' };
          i++; // Longs take two entries
          break;
        case CONSTANT_Double:
          reader.skip(8);
          cp[i] = { tag, value: 'double' };
          i++; // Doubles take two entries
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
            nameAndTypeIndex: reader.readU2(),
          };
          break;
        case CONSTANT_NameAndType:
          cp[i] = {
            tag,
            nameIndex: reader.readU2(),
            descriptorIndex: reader.readU2(),
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

    const getUtf8 = (idx: number): string => {
      const entry = cp[idx];
      return entry && entry.tag === CONSTANT_Utf8 ? entry.value : '';
    };

    const getClassName = (classIdx: number): string => {
      const entry = cp[classIdx];
      if (entry && entry.tag === CONSTANT_Class) {
        return getUtf8(entry.nameIndex).replace(/\//g, '.');
      }
      return '';
    };

    const accessFlags = reader.readU2();
    const thisClassIdx = reader.readU2();
    const superClassIdx = reader.readU2();

    const fullClassName = getClassName(thisClassIdx) || classNameFallback;
    const superClassName = getClassName(superClassIdx);

    const interfacesCount = reader.readU2();
    const interfaces: string[] = [];
    for (let i = 0; i < interfacesCount; i++) {
      const ifaceIdx = reader.readU2();
      const ifaceName = getClassName(ifaceIdx);
      if (ifaceName) interfaces.push(ifaceName);
    }

    // Helper for Java version name
    const javaVersionMap: Record<number, string> = {
      49: 'Java 5', 50: 'Java 6', 51: 'Java 7', 52: 'Java 8',
      53: 'Java 9', 54: 'Java 10', 55: 'Java 11', 56: 'Java 12',
      57: 'Java 13', 58: 'Java 14', 59: 'Java 15', 60: 'Java 16',
      61: 'Java 17', 62: 'Java 18', 63: 'Java 19', 64: 'Java 20',
      65: 'Java 21', 66: 'Java 22', 67: 'Java 23',
    };
    const javaVersionStr = javaVersionMap[majorVersion] || `class version ${majorVersion}.${minorVersion}`;

    // Read Fields
    const fieldsCount = reader.readU2();
    interface FieldInfo {
      accessFlags: number;
      name: string;
      descriptor: string;
      signature?: string;
    }
    const fields: FieldInfo[] = [];
    for (let i = 0; i < fieldsCount; i++) {
      const fFlags = reader.readU2();
      const fName = getUtf8(reader.readU2());
      const fDesc = getUtf8(reader.readU2());
      const attrCount = reader.readU2();
      let fSig: string | undefined;
      for (let a = 0; a < attrCount; a++) {
        const attrName = getUtf8(reader.readU2());
        const attrLen = reader.readU4();
        if (attrName === 'Signature' && attrLen === 2) {
          fSig = getUtf8(reader.readU2());
        } else {
          reader.skip(attrLen);
        }
      }
      fields.push({ accessFlags: fFlags, name: fName, descriptor: fDesc, signature: fSig });
    }

    // Read Methods
    const methodsCount = reader.readU2();
    interface MethodInfo {
      accessFlags: number;
      name: string;
      descriptor: string;
      signature?: string;
      instructions?: string[];
    }
    const methods: MethodInfo[] = [];
    for (let i = 0; i < methodsCount; i++) {
      const mFlags = reader.readU2();
      const mName = getUtf8(reader.readU2());
      const mDesc = getUtf8(reader.readU2());
      const attrCount = reader.readU2();
      let mSig: string | undefined;
      let instructions: string[] = [];

      for (let a = 0; a < attrCount; a++) {
        const attrName = getUtf8(reader.readU2());
        const attrLen = reader.readU4();
        if (attrName === 'Signature' && attrLen === 2) {
          mSig = getUtf8(reader.readU2());
        } else if (attrName === 'Code') {
          // Parse code block
          const maxStack = reader.readU2();
          const maxLocals = reader.readU2();
          const codeLen = reader.readU4();
          const codeBytes = reader.readBytes(codeLen);
          instructions = disassembleBytecode(codeBytes, cp, getUtf8, getClassName);

          // Exception table
          const exceptionTableLen = reader.readU2();
          reader.skip(exceptionTableLen * 8);

          // Code attributes
          const codeAttrCount = reader.readU2();
          for (let ca = 0; ca < codeAttrCount; ca++) {
            reader.readU2(); // name
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
        instructions,
      });
    }

    // Class attributes
    const classAttrCount = reader.readU2();
    let classSignature: string | undefined;
    for (let a = 0; a < classAttrCount; a++) {
      const attrName = getUtf8(reader.readU2());
      const attrLen = reader.readU4();
      if (attrName === 'Signature' && attrLen === 2) {
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
      classSignature,
    });
  } catch (err: any) {
    return `// Decompiler error: ${err.message || 'Failed to parse class file'}\n`;
  }
}

// Convert JVM field descriptor (e.g. "Ljava/lang/String;") to Java type
function parseFieldDescriptor(desc: string): string {
  if (!desc) return 'void';
  if (desc === 'Z') return 'boolean';
  if (desc === 'B') return 'byte';
  if (desc === 'C') return 'char';
  if (desc === 'S') return 'short';
  if (desc === 'I') return 'int';
  if (desc === 'J') return 'long';
  if (desc === 'F') return 'float';
  if (desc === 'D') return 'double';
  if (desc === 'V') return 'void';

  if (desc.startsWith('[')) {
    return parseFieldDescriptor(desc.substring(1)) + '[]';
  }
  if (desc.startsWith('L') && desc.endsWith(';')) {
    const raw = desc.substring(1, desc.length - 1).replace(/\//g, '.');
    return cleanTypeName(raw);
  }
  return desc;
}

function cleanTypeName(full: string): string {
  // If common java.lang package, omit package prefix
  if (full.startsWith('java.lang.') && full.split('.').length === 3) {
    return full.substring(10);
  }
  return full;
}

// Parse method descriptor "(Ljava/lang/String;I)Z" into params and return type
function parseMethodDescriptor(desc: string): { params: string[]; returnType: string } {
  const match = desc.match(/^\((.*?)\)(.*)$/);
  if (!match) return { params: [], returnType: 'void' };

  const rawParams = match[1];
  const rawRet = match[2];
  const params: string[] = [];

  let idx = 0;
  while (idx < rawParams.length) {
    let arrDim = 0;
    while (rawParams[idx] === '[') {
      arrDim++;
      idx++;
    }
    const ch = rawParams[idx];
    if (ch === 'L') {
      const end = rawParams.indexOf(';', idx);
      if (end === -1) break;
      const type = rawParams.substring(idx + 1, end).replace(/\//g, '.');
      params.push(cleanTypeName(type) + '[]'.repeat(arrDim));
      idx = end + 1;
    } else {
      const primitive = parseFieldDescriptor(ch);
      params.push(primitive + '[]'.repeat(arrDim));
      idx++;
    }
  }

  return {
    params,
    returnType: cleanTypeName(parseFieldDescriptor(rawRet)),
  };
}

function formatAccessFlags(flags: number, isClass = false, isInterface = false): string {
  const parts: string[] = [];
  if (flags & ACC_PUBLIC) parts.push('public');
  if (flags & ACC_PROTECTED) parts.push('protected');
  if (flags & ACC_PRIVATE) parts.push('private');
  if (flags & ACC_ABSTRACT && !isInterface) parts.push('abstract');
  if (flags & ACC_STATIC) parts.push('static');
  if (flags & ACC_FINAL) parts.push('final');
  if (flags & ACC_SYNCHRONIZED) parts.push('synchronized');
  if (flags & ACC_NATIVE) parts.push('native');
  if (flags & ACC_VOLATILE) parts.push('volatile');
  if (flags & ACC_TRANSIENT) parts.push('transient');
  return parts.join(' ');
}

// Fast bytecode disassembler into readable pseudocode statements
function disassembleBytecode(
  code: Uint8Array,
  cp: (ConstantPoolEntry | null)[],
  getUtf8: (idx: number) => string,
  getClassName: (idx: number) => string
): string[] {
  const statements: string[] = [];
  let i = 0;

  const getNameAndType = (idx: number): { name: string; descriptor: string } => {
    const entry = cp[idx];
    if (entry && entry.tag === CONSTANT_NameAndType) {
      return {
        name: getUtf8(entry.nameIndex),
        descriptor: getUtf8(entry.descriptorIndex),
      };
    }
    return { name: '', descriptor: '' };
  };

  const getMemberRef = (idx: number): { owner: string; name: string; descriptor: string } => {
    const entry = cp[idx];
    if (entry && (entry.tag === CONSTANT_Methodref || entry.tag === CONSTANT_Fieldref || entry.tag === CONSTANT_InterfaceMethodref)) {
      const owner = getClassName(entry.classIndex);
      const nt = getNameAndType(entry.nameAndTypeIndex);
      return { owner, name: nt.name, descriptor: nt.descriptor };
    }
    return { owner: '', name: '', descriptor: '' };
  };

  while (i < code.length) {
    const op = code[i];
    switch (op) {
      case 0x00: // nop
        i++;
        break;
      case 0x01: // aconst_null
        statements.push('// push null');
        i++;
        break;
      case 0xb2: // getstatic
      case 0xb4: { // getfield
        const refIdx = (code[i + 1] << 8) | code[i + 2];
        const member = getMemberRef(refIdx);
        const prefix = op === 0xb2 ? member.owner : 'this';
        statements.push(`// access ${prefix}.${member.name} (${cleanTypeName(parseFieldDescriptor(member.descriptor))})`);
        i += 3;
        break;
      }
      case 0xb3: // putstatic
      case 0xb5: { // putfield
        const refIdx = (code[i + 1] << 8) | code[i + 2];
        const member = getMemberRef(refIdx);
        const prefix = op === 0xb3 ? member.owner : 'this';
        statements.push(`// assign ${prefix}.${member.name}`);
        i += 3;
        break;
      }
      case 0xb6: // invokevirtual
      case 0xb7: // invokespecial
      case 0xb8: // invokestatic
      case 0xb9: { // invokeinterface
        const refIdx = (code[i + 1] << 8) | code[i + 2];
        const member = getMemberRef(refIdx);
        const callType = op === 0xb8 ? 'static call' : op === 0xb7 ? 'special call' : 'call';
        statements.push(`${callType} ${member.owner}.${member.name}(...);`);
        i += op === 0xb9 ? 5 : 3;
        break;
      }
      case 0x12: { // ldc
        const cIdx = code[i + 1];
        const cEntry = cp[cIdx];
        if (cEntry && cEntry.tag === CONSTANT_String) {
          const s = getUtf8(cEntry.stringIndex);
          statements.push(`// load string "${s.length > 50 ? s.slice(0, 47) + '...' : s}"`);
        }
        i += 2;
        break;
      }
      case 0xbb: { // new
        const classIdx = (code[i + 1] << 8) | code[i + 2];
        const clsName = getClassName(classIdx);
        statements.push(`new ${clsName}();`);
        i += 3;
        break;
      }
      case 0xac: // ireturn
      case 0xad: // lreturn
      case 0xae: // freturn
      case 0xaf: // dreturn
      case 0xb0: // areturn
        statements.push('return result;');
        i++;
        break;
      case 0xb1: // return
        statements.push('return;');
        i++;
        break;
      case 0xbf: // athrow
        statements.push('throw exception;');
        i++;
        break;
      default:
        i++;
        break;
    }
  }

  // Deduplicate consecutive comments to keep digest clean and concise
  const cleaned: string[] = [];
  let lastWasComment = false;
  for (const s of statements) {
    if (s.startsWith('//')) {
      if (!lastWasComment) cleaned.push(s);
      lastWasComment = true;
    } else {
      cleaned.push(s);
      lastWasComment = false;
    }
  }

  return cleaned.slice(0, 20); // Limit statements per method to maintain concise context
}

function formatJavaSource(info: {
  fullClassName: string;
  superClassName: string;
  interfaces: string[];
  accessFlags: number;
  fields: any[];
  methods: any[];
  javaVersionStr: string;
  classSignature?: string;
}): string {
  const parts = info.fullClassName.split('.');
  const simpleName = parts.pop() || 'Unknown';
  const packageName = parts.join('.');

  const isInterface = Boolean(info.accessFlags & ACC_INTERFACE);
  const isEnum = Boolean(info.accessFlags & ACC_ENUM);
  const kind = isInterface ? 'interface' : isEnum ? 'enum' : 'class';

  const lines: string[] = [];
  lines.push(`// Decompiled from Java .class bytecode (${info.javaVersionStr})`);
  lines.push(`// Source: ${info.fullClassName}`);
  lines.push('');

  if (packageName) {
    lines.push(`package ${packageName};`);
    lines.push('');
  }

  // Class declaration
  const classModifier = formatAccessFlags(info.accessFlags, true, isInterface);
  let decl = `${classModifier ? classModifier + ' ' : ''}${kind} ${simpleName}`;

  if (info.superClassName && info.superClassName !== 'java.lang.Object' && !isInterface && !isEnum) {
    decl += ` extends ${info.superClassName}`;
  }
  if (info.interfaces.length > 0) {
    decl += ` ${isInterface ? 'extends' : 'implements'} ${info.interfaces.join(', ')}`;
  }
  decl += ' {';
  lines.push(decl);

  // Fields
  if (info.fields.length > 0) {
    for (const f of info.fields) {
      const fMods = formatAccessFlags(f.accessFlags);
      const fType = cleanTypeName(parseFieldDescriptor(f.descriptor));
      lines.push(`    ${fMods ? fMods + ' ' : ''}${fType} ${f.name};`);
    }
    lines.push('');
  }

  // Methods
  for (const m of info.methods) {
    const isInit = m.name === '<init>';
    const isClinit = m.name === '<clinit>';

    if (isClinit) {
      lines.push('    static {');
      if (m.instructions && m.instructions.length > 0) {
        for (const inst of m.instructions) {
          lines.push(`        ${inst}`);
        }
      }
      lines.push('    }');
      lines.push('');
      continue;
    }

    const mMods = formatAccessFlags(m.accessFlags);
    const { params, returnType } = parseMethodDescriptor(m.descriptor);

    const mName = isInit ? simpleName : m.name;
    const mRet = isInit ? '' : returnType + ' ';

    // Format parameters
    const paramStr = params.map((p, idx) => `${p} arg${idx}`).join(', ');

    const isAbstract = Boolean(m.accessFlags & ACC_ABSTRACT) || isInterface;
    if (isAbstract) {
      lines.push(`    ${mMods ? mMods + ' ' : ''}${mRet}${mName}(${paramStr});`);
    } else {
      lines.push(`    ${mMods ? mMods + ' ' : ''}${mRet}${mName}(${paramStr}) {`);
      if (m.instructions && m.instructions.length > 0) {
        for (const inst of m.instructions) {
          lines.push(`        ${inst}`);
        }
      } else {
        lines.push('        // [Compiled method body]');
      }
      lines.push('    }');
    }
    lines.push('');
  }

  lines.push('}');
  return lines.join('\n');
}
