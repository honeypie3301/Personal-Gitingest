import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { decompileJavaClass, isJavaClassBuffer } from '../../src/services/decompiler/javaClassDecompiler';

const inputDirectory = process.argv[2];
const rounds = Math.max(1, Number.parseInt(process.argv[3] || '3', 10) || 3);

if (!inputDirectory) {
  console.error('Usage: npm run benchmark:decompiler -- <directory-containing-class-files> [rounds]');
  process.exitCode = 1;
} else {
  const classFiles: string[] = [];
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.class')) classFiles.push(fullPath);
    }
  }

  await collect(path.resolve(inputDirectory));
  const classes = await Promise.all(classFiles.map(async file => ({
    file,
    name: path.basename(file, '.class'),
    bytes: new Uint8Array(await readFile(file)),
  })));
  const validClasses = classes.filter(item => isJavaClassBuffer(item.bytes));
  if (validClasses.length === 0) {
    console.error(`No valid .class files found in ${inputDirectory}`);
    process.exitCode = 1;
  } else {
    console.log(`Benchmarking ${validClasses.length} class files (${rounds} rounds; no result cache)`);
    for (const engine of ['auto', 'typescript'] as const) {
      const durations: number[] = [];
      let outputCharacters = 0;
      for (let round = 0; round < rounds; round++) {
        const start = performance.now();
        const outputs = await Promise.all(validClasses.map(item =>
          decompileJavaClass(item.bytes, item.name)
        ));
        durations.push(performance.now() - start);
        outputCharacters = outputs.reduce((total, output) => total + output.length, 0);
      }
      const sorted = [...durations].sort((a, b) => a - b);
      const medianMs = sorted[Math.floor(sorted.length / 2)];
      const filePerSecond = validClasses.length / (medianMs / 1000);
      console.log(`${engine}: median ${medianMs.toFixed(1)} ms; ${filePerSecond.toFixed(1)} classes/s; ${outputCharacters.toLocaleString()} output chars; rounds [${durations.map(value => value.toFixed(1)).join(', ')}] ms`);
    }
  }
}
