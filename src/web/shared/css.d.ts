/**
 * `import './style.css'` 的类型声明。
 *
 * esbuild 认识 CSS 入口(会为每个 bundle 产出同名 .css,清单里作为 `client.css`
 * 交给控制台注入),但 tsc 不认识——没有这一句,`tsconfig.web.json` 会在
 * `import './style.css'` 上报 TS2307。
 *
 * 这是**环境声明**,一旦进了浏览器端那份 program 就对整份程序生效,所以由 Web Core
 * 提供**一次**即可,不该每个写 CSS 的 provider 各复制一份:声明本身没有 provider
 * 的成分,复制出来的每一份都只是同一句话的副本,而副本越多,哪天要收紧它
 * (比如改成 `declare module '*.css' { const url: string; export default url; }`)
 * 就越难改全。
 *
 * `tsconfig.web.json` 的 `include` 里 `src/web/shared/**\/*.ts` 覆盖得到它——
 * TS 的 include 通配按**文件名后缀**匹配,`.d.ts` 也是以 `.ts` 结尾的;
 * 各 provider 的 `console/` 目录下若有同名声明,走的是同一条规则。
 */
declare module '*.css';
