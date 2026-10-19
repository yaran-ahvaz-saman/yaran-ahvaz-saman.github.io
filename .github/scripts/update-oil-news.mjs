import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const feeds = [
  { url: "https://www.shana.ir/rss/tp/14", section: "نفت" },
  { url: "https://www.shana.ir/rss/tp/18", section: "گاز" },
];

const allowedHosts = new Set(["shana.ir", "www.shana.ir"]);
const maxFeedBytes = 2_000_000;
const lowPriorityTerms = ["پیام تبریک", "پیام تسلیت", "انتصاب", "گرامیداشت", "دیدار نوروزی", "مراسم", "نشست شورای", "پرستار"];
const headlineTerms = [
  "چاه", "حفاری", "سرچاه", "میدان", "تولید نفت", "تولید گاز", "پالایشگاه", "پتروشیمی",
  "انتقال گاز", "خط لوله", "تأسیسات", "تجهیز", "تعمیرات اساسی", "فناوری", "هوش مصنوعی",
  "قرارداد نفت", "سرمایه‌گذاری نفت", "پارس جنوبی", "صنعت نفت", "صنعت گاز",
];

function trustedUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && allowedHosts.has(parsed.hostname) ? parsed.href : "";
  } catch {
    return "";
  }
}

const decode = (value = "") => value
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/\s+/g, " ")
  .trim();

const tag = (xml, name) => decode(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1]);
const attr = (xml, element, name) => xml.match(new RegExp(`<${element}[^>]*\\s${name}="([^"]+)"`, "i"))?.[1] ?? "";

function conciseSummary(value) {
  const clean = decode(value);
  const sentences = clean.match(/[^.!؟]+[.!؟]?/g) ?? [clean];
  const selected = sentences.slice(0, 2).join(" ").trim();
  if (selected.length <= 420) return selected;
  const shortened = selected.slice(0, 417).replace(/\s+\S*$/, "").trim();
  return `${shortened}…`;
}

async function readFeed(feed) {
  if (!trustedUrl(feed.url)) throw new Error(`Untrusted feed URL: ${feed.url}`);
  const response = await fetch(feed.url, {
    headers: { "user-agent": "YAS-Company-Website/1.0 (+https://yas.co.ir)" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${feed.url}: HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > maxFeedBytes) throw new Error(`${feed.url}: feed exceeds size limit`);
  const xml = await response.text();
  if (Buffer.byteLength(xml, "utf8") > maxFeedBytes) throw new Error(`${feed.url}: feed exceeds size limit`);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => {
    const item = match[1];
    const publishedAt = tag(item, "pubDate");
    const itemUrl = trustedUrl(tag(item, "link"));
    const timestamp = Date.parse(publishedAt);
    return {
      title: tag(item, "title"),
      summary: conciseSummary(tag(item, "description")),
      url: itemUrl,
      image: trustedUrl(attr(item, "enclosure", "url")),
      section: tag(item, "category") || feed.section,
      publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "",
      source: "شانا",
    };
  }).filter((item) => item.title && item.title.length <= 300 && item.url && item.publishedAt);
}

const results = (await Promise.all(feeds.map(readFeed))).flat();
const headlineRelevant = (item) => headlineTerms.some((term) => item.title.includes(term))
  && !lowPriorityTerms.some((term) => item.title.includes(term));

const deduplicated = [...new Map(results.map((item) => [item.url, item])).values()];
const newestTimestamp = Math.max(...deduplicated.map((item) => Date.parse(item.publishedAt)));
const recentRelevant = deduplicated.filter((item) =>
  Date.parse(item.publishedAt) >= newestTimestamp - 4 * 24 * 60 * 60 * 1000 && headlineRelevant(item),
);
const unique = (recentRelevant.length >= 6 ? recentRelevant : deduplicated.filter(headlineRelevant))
  .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
  .slice(0, 12);

if (!unique.length) throw new Error("No news items were parsed from SHANA feeds.");

const output = resolve("data/oil-news.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ updatedAt: new Date().toISOString(), sourceName: "شبکه اطلاع‌رسانی نفت و انرژی (شانا)", sourceUrl: "https://www.shana.ir", items: unique }, null, 2)}\n`, "utf8");
console.log(`Updated ${output} with ${unique.length} items.`);
