/**
 * 密钥读取:按名字同步取一个静态字符串。没有写回、没有失效、没有异步——
 * 有生命周期的凭据(OAuth 的旋转 refresh token)不走这条链,归 provider 模块自己管。
 */
import { existsSync, readFileSync } from 'node:fs';

/**
 * 一份 `.env` 的读取器:**进程环境 > 这份文件**,读不到给空串。
 * 文件内容读一次就记住:一次运行里密钥不会自己变。
 */
export function secretReader(file: string): (name: string) => string {
  let text: string | null = null;
  return (name: string): string => {
    const fromEnv = process.env[name];
    if (fromEnv) return fromEnv;
    if (text === null) text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(\\S+)`, 'm').exec(text);
    return m ? m[1] : '';
  };
}
