/**
 * UI 插槽（P3.2）的出口。
 *
 *   const core = new SlotCore();
 *   ctx.provide("slots", contextBoundService((c) => createSlotsService(core, c)));
 *   // 插件里：
 *   const slots = ctx.get<SlotsService>("slots");
 *   slots.register({ name: "reader.view.tail", id: "pages", component: MyCard });
 *   // 宿主里：
 *   <SlotView slots={slots} name="reader.view.tail" hostProps={{ book }} />
 */

export { SlotCore } from "./core";
export type { SlotOwner } from "./core";
export { createSlotsService } from "./service";
export { SlotView, SlotBoundary } from "./SlotView";
export { SlotError } from "./types";
export type {
  ReplaceRisk,
  SlotCatalogEntry,
  SlotCell,
  SlotDeclaration,
  SlotEntry,
  SlotErrorCode,
  SlotKind,
  SlotRegistration,
  SlotScope,
  SlotsReader,
  SlotsService,
} from "./types";
