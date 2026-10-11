/** 教务通知的网页视图：按同学年级给抓取快照打相关性分（GET /api/news 数据源）。 */

import { loadUserGrade } from "../../core/memory/longterm";
import { relevanceOf } from "../../core/notices";
import { school } from "../../core/school";

export interface ScoredNewsItem {
  title: string;
  date: string;
  category: string | undefined;
  relevance: "high" | "medium" | "low";
  relevanceReason: string | undefined;
  url: string;
  /** 官网设置了访问权限的文章：原文页匿名打开是「您无权访问此页面」 */
  restricted: boolean | undefined;
}

export interface ScoredNewsSnapshot {
  items: ScoredNewsItem[];
  gradeBasis: string | null;
  fetchedAt: number;
  /** 非空表示这次是降级快照（官网直连失败），前端要提示不新鲜 */
  staleAt?: number;
}

/**
 * 教务处通知的评分视图。官网抓取与 5 分钟 TTL 缓存在适配器的
 * fetchNewsMemo 里（get_news 工具与这里共用同一份快照，面板刚看过、
 * 对话里再问不会重复抓三页）；这里只负责按同学年级打相关性分。
 * 走 fetchNews（吞错版）的旧路径会让「抓取失败」显示成「无通知」，
 * 现在失败会如实抛给 /api/news 的 catch 上报。
 */
export async function scoredNewsSnapshot(): Promise<ScoredNewsSnapshot> {
  const notices = school().notices;
  const raw = notices?.fetchNewsMemo
    ? await notices.fetchNewsMemo(30)
    : { items: (await notices?.fetchNews([], 30)) ?? [], staleAt: undefined };
  const grade = await loadUserGrade();
  const scored = raw.items.slice(0, 10).map((i) => {
    const { level, reason } = relevanceOf(i.title, grade);
    return {
      title: i.title,
      date: i.date,
      category: i.category,
      relevance: level,
      relevanceReason: reason,
      url: i.url,
      restricted: i.restricted ?? undefined,
    };
  });
  return {
    items: scored,
    gradeBasis: grade,
    // 降级快照的时间要如实反映抓取时刻，不能拿「现在」冒充
    fetchedAt: raw.staleAt ?? Date.now(),
    staleAt: raw.staleAt,
  };
}
