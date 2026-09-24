/**
 * 统一抓取结果形状 — 教务客户端与天气等外部请求共用
 *
 * 「ok + data 或 error 人话」的判别联合：调用方永远拿到明确的结果分支，
 * 不用 try/catch 混着 null 判断。原先定义在 jwgl/http，天气域借用时把
 * 两个不相干的域耦在一起，提到公共位置后各自独立引用。
 */

export type FetchResult<T> = { ok: true; data: T } | { ok: false; error: string };
