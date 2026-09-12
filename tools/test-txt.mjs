import { readFileSync, writeFileSync } from "node:fs";
import { txtToEpubFile, splitChapters } from "../app/src/reader/txtToEpub.ts";

const text = readFileSync("fixtures/huge.txt", "utf8");
const t0 = performance.now();
const chapters = splitChapters(text);
console.log("章节数:", chapters.length, "切分耗时:", Math.round(performance.now() - t0), "ms");

const t1 = performance.now();
const { file, stats } = await txtToEpubFile(text, "huge");
writeFileSync("fixtures/huge.epub", Buffer.from(await file.arrayBuffer()));
console.log("转换:", JSON.stringify(stats), "总耗时:", Math.round(performance.now() - t1), "ms");
