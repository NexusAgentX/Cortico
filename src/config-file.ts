import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export type JsonObject = Record<string, unknown>;

export function readJsonObject(file: string): JsonObject {
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('root must be an object');
    }
    return value as JsonObject;
  } catch {
    throw new Error('config.json解析失败,拒绝写回(请手工检查文件)');
  }
}

export function updateJsonObject(file: string, update: (root: JsonObject) => void): void {
  const root = readJsonObject(file);
  update(root);

  const suffix = `${process.pid}-${randomUUID()}`;
  const tmp = `${file}.tmp-${suffix}`;
  const backup = `${file}.bak-${suffix}`;
  writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  if (!existsSync(file)) {
    renameSync(tmp, file);
    return;
  }

  renameSync(file, backup);
  try {
    renameSync(tmp, file);
  } catch (error) {
    renameSync(backup, file);
    throw error;
  }
  rmSync(backup);
}
