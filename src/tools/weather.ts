/**
 * 天气工具：get_weather
 */

import { tool } from "ai";
import { z } from "zod";

import { defaultWeatherCity, fetchWeather } from "../weather";

export const weatherTools = {
  /** 天气查询 */
  get_weather: tool({
    description:
      "查询天气：实况（温度/体感/湿度/风）+ 未来若干天预报。天气码已翻成中文，并给出带伞与穿衣建议。默认查学校所在城市（南京工业大学→南京），用户提到别的城市就用 city 传（如「三亚」）。用户问「明天冷不冷」「要带伞吗」「周末天气」「老家天气」时直接调用，不要反问城市。",
    inputSchema: z.object({
      city: z.string().optional().describe("中文城市名，如「南京」「海口」；不填则查学校所在城市"),
      days: z.number().int().min(1).max(14).default(7).describe("预报天数（默认 7，最多 14）"),
    }),
    execute: async ({ city, days }) => {
      const wanted = city?.trim();
      const r = await fetchWeather(wanted || defaultWeatherCity(), days);
      if (!r.ok) {
        // 与课表同一套契约：查不到 ≠ 天气好，别让模型拿空数据编一个晴天
        return {
          error: `天气查询失败：${r.error}。这与「当地天气晴好」不是一回事，请如实告知用户查询失败。`,
        };
      }
      const w = r.data;
      return {
        city: w.city,
        localTime: w.localTime,
        now: {
          text: w.now.text,
          tempC: w.now.tempC,
          feelsLikeC: w.now.feelsLikeC,
          humidity: `${w.now.humidity}%`,
          wind: `${w.now.windKmh} km/h`,
        },
        days: w.days.map((d) => ({
          date: d.date,
          weekday: d.weekday,
          text: d.text,
          temp: `${d.minC}~${d.maxC}℃`,
          rainChance: d.rainChance == null ? undefined : `${d.rainChance}%`,
        })),
        advice: w.advice.length ? w.advice : undefined,
        note: wanted
          ? undefined
          : `未指定城市，按学校所在地查询：${w.city}。用户想查别的地方，让他直接说城市名。`,
      };
    },
  }),
};
