/**
 * protobuf 线格式读取器，仅解字段号、wire type 与原始值，不使用 .proto 或执行类型映射；调用方解释字段布局。
 * 读取失败返回 null、undefined 或空串，不抛异常、不编造默认值，由调用方决定省略或告警。
 * 单值字段按 protobuf 语义取同字段号最后一次出现的值。
 */

/** 一个字段的原始读数。`varint` / `bytes` 按 wire type 二选一。 */
export interface PbField {
  readonly field: number;
  readonly wire: number;
  readonly varint?: bigint;
  readonly bytes?: Uint8Array;
}

/** 非 UTF-8 就当没读到,别把嵌套消息的字节当字符串端出去 */
const TEXT = new TextDecoder('utf-8', { fatal: true });

/**
 * 拆一层字段。返回 null = 这段字节不是完整的 protobuf(截断、越界、或者
 * 撞上早已废弃的 group wire type),调用方按"读不出来"处理。
 */
export function pbDecode(buf: Uint8Array): PbField[] | null {
  const out: PbField[] = [];
  let i = 0;
  while (i < buf.length) {
    const key = readVarint(buf, i);
    if (!key) return null;
    i = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (field <= 0) return null;
    if (wire === 0) {
      const value = readVarint(buf, i);
      if (!value) return null;
      i = value.next;
      out.push({ field, wire, varint: value.value });
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len) return null;
      const start = len.next;
      const end = start + Number(len.value);
      if (!Number.isSafeInteger(end) || end > buf.length) return null;
      out.push({ field, wire, bytes: buf.subarray(start, end) });
      i = end;
    } else if (wire === 5 || wire === 1) {
      const width = wire === 5 ? 4 : 8;
      if (i + width > buf.length) return null;
      out.push({ field, wire, bytes: buf.subarray(i, i + width) });
      i += width;
    } else {
      return null;
    }
  }
  return out;
}

/** base64 字符串 → 字段表。不是字符串、base64 坏了、或者不是 protobuf 都给 null。 */
export function pbFromBase64(value: unknown): PbField[] | null {
  if (typeof value !== 'string' || !value) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, 'base64');
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  return pbDecode(bytes);
}

/** 取嵌套消息。不是长度分隔字段、或者内容不是完整 protobuf 都给 null。 */
export function pbSub(fields: readonly PbField[] | null, field: number): PbField[] | null {
  const bytes = pick(fields, field)?.bytes;
  return bytes ? pbDecode(bytes) : null;
}

/** 取字符串。没有这个字段、不是长度分隔、或者不是合法 UTF-8 一律 ''。 */
export function pbText(fields: readonly PbField[] | null, field: number): string {
  const bytes = pick(fields, field)?.bytes;
  if (!bytes) return '';
  let text: string;
  try {
    text = TEXT.decode(bytes);
  } catch {
    return '';
  }
  // 有控制字符 = 多半把嵌套消息当成字符串读了
  return hasControlChars(text) ? '' : text;
}

/**
 * 取整数。超出安全整数范围就当没读到——uid、金瓜子、等级都在范围内,
 * 越界只说明字段号对错了,这时候端一个精度已经掉了的数出去更糟。
 */
export function pbInt(fields: readonly PbField[] | null, field: number): number | undefined {
  const value = pick(fields, field)?.varint;
  if (value === undefined) return undefined;
  const num = Number(value);
  return Number.isSafeInteger(num) ? num : undefined;
}

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/** 单数字段取最后一条(protobuf 语义) */
function pick(fields: readonly PbField[] | null, field: number): PbField | undefined {
  if (!fields) return undefined;
  for (let i = fields.length - 1; i >= 0; i -= 1) {
    if (fields[i].field === field) return fields[i];
  }
  return undefined;
}

/** varint。10 字节封顶(64 位的上限),越界或没有终止位都算读不动。 */
function readVarint(buf: Uint8Array, from: number): { value: bigint; next: number } | null {
  let value = 0n;
  let shift = 0n;
  for (let i = from; i < buf.length && i - from < 10; i += 1) {
    const byte = buf[i];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    shift += 7n;
  }
  return null;
}
