/**
 * 插槽服务（P3.2）：插件看到的那一面。
 *
 * 它被注册成**按上下文绑定**的服务（container 的 contextBoundService）：插件 ⟨ctx.get("slots")⟩
 * 拿到的是"以它自己的 fiber 为所有者"的 facade，于是
 *   - 注册返回的 disposer 自动挂到**那个插件**的 fiber 上（卸载插件 = 它的插槽一起消失）；
 *   - 诊断里能说清"这块 UI 是谁挂的"。
 *
 * 这也是 DSH 的行为（client-runner 把动态包的注册强制绑到调用 fiber 上），
 * 只是我们用"per-ctx facade"实现了同一件事。
 */

import type { Context, Disposer } from "../../core/service/types";
import { SlotCore, type SlotOwner } from "./core";
import type { SlotsService, SlotDeclaration, SlotRegistration } from "./types";

export function createSlotsService(core: SlotCore, ctx: Context): SlotsService {
  const owner: SlotOwner = { label: ctx.fiber.name, uid: ctx.fiber.uid };
  const facade: SlotsService = {
    register<P>(options: SlotRegistration<P>): Disposer {
      // 挂到调用者的 fiber 上：插件卸载时这块 UI 跟着消失
      return ctx.effect(
        () => core.register(options, owner),
        "slot-register:" + options.name + (options.id ? "#" + options.id : options.key ? "@" + options.key : ""),
      );
    },
    inject(name, cb) {
      return ctx.effect(() => {
        let inner: Disposer | null = null;
        let epoch = -1;
        const stop = () => {
          const fn = inner;
          inner = null;
          if (fn) {
            try {
              void fn();
            } catch {
              /* 清理失败只记不抛 */
            }
          }
        };
        const check = () => {
          if (!core.declared(name)) {
            stop();
            return;
          }
          if (epoch === core.declarationEpoch()) return;
          stop();
          epoch = core.declarationEpoch();
          const result = cb(facade);
          inner = typeof result === "function" ? result : null;
        };
        const off = core.onChange(check);
        check();
        return () => {
          off();
          stop();
        };
      }, "slot-inject:" + name);
    },
    declare(name: string, declaration: SlotDeclaration): Disposer {
      return ctx.effect(() => core.declare(name, declaration, owner), "slot-declare:" + name);
    },
    ownsChild: (uid, child) => core.ownsChild(uid, child),
    childrenOf: (uid) => core.childrenOf(uid),
    declared: (name) => core.declared(name),
    declaration: (name) => core.declaration(name),
    of: (name) => core.of(name),
    catalog: () => core.catalog(),
    version: () => core.version(),
    onChange: (fn) => core.onChange(fn),
    abdicate: (uid, error) => core.abdicate(uid, error),
  };
  return facade;
}
