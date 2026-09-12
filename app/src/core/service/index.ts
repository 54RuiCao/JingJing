/**
 * 服务容器（P3.0）的出口。用法：
 *
 *   const container = createContainer();
 *   container.ctx.provide("db", dbService);              // 底座能力挂在 root fiber 上
 *   const fiber = container.ctx.plugin(toolsPlugin);      // 内置插件 = 子 fiber
 *   await fiber.ready;                                    // ACTIVE / PENDING 都算落地
 *   await fiber.dispose();                                // 卸载：它注册的工具/服务一起消失
 *
 * 依赖等待不需要任何声明式魔法：插件的 inject 里写服务名，服务没出现它就停在 PENDING，
 * 出现时自动加载，被换掉时自动重载（epoch 比对，见 fiber.ts）。
 */

export { createContainer, Container } from "./registry";
export type { ContainerOptions, ContainerDiagnostics, FiberDiagnostics } from "./registry";
export { ContextImpl } from "./context";
export type { ContextHost } from "./context";
export { Fiber, ValidationError, collectDisposables, collectSync, normalizePlugin } from "./fiber";
export type { FiberHost, NormalizedPlugin } from "./fiber";
export { Reflect } from "./reflect";
export type { ServiceEntry } from "./reflect";
export { FiberState, INACTIVE, FIBER_STATE_EVENT, SERVICE_CHANGE_EVENT, contextBoundService, isContextBoundService } from "./types";
export type {
  Context,
  ContextBoundService,
  Disposable,
  Disposer,
  Fiber as FiberShape,
  Plugin,
  PluginObject,
  StandardSchemaV1,
  ValidationIssue,
} from "./types";
