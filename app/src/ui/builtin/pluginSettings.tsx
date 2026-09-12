/**
 * 内置插件：设置面板里的「插件」分区（P3.2 的样例之一，也是 P3.1 加载器第一次真正露出界面）。
 *
 * 它只做三件事，全部来自服务：
 *   - ⟨plugins.list()⟩ → 插件列表（状态 / 来源 / 版本 / 能力 / 失败原因）
 *   - ⟨plugins.setEnabled()⟩ → 开关
 *   - ⟨plugins.manifestOf() + configOf() + reload()⟩ → 按 manifest 的 JSON Schema **现渲染配置表单**
 *
 * 注意它不 import 任何加载器内部结构：插件在 UI 层也是"只见服务"的。
 */

import { useState } from "react";
import { useT } from "../../i18n/react";
import { t } from "../../i18n";
import type { MessageKey } from "../../i18n";
import { builtinName, builtinPurpose } from "./builtinNames";
import { HOST_API_VERSION } from "../../core/plugin/manifest";
import type { BuiltinPlugin, PermissionsService, PluginsService, PluginStatus } from "../../core/plugin/types";
import type { JsonSchemaNode } from "../../core/jsonSchema";
import type { SlotsService } from "../slots/types";

/** 状态 → 界面文案的 key（语言可能在运行期切换，取词必须等到渲染时） */
const STATE_LABEL: Record<string, MessageKey> = {
  ACTIVE: "plug.state.active",
  PENDING_PERMISSION: "plug.state.pendingPermission",
  PENDING: "plug.state.pending",
  FAILED: "plug.state.failed",
  INVALID: "plug.state.invalid",
  DISABLED: "plug.state.disabled",
  UNAVAILABLE: "plug.state.unavailable",
  UNMOUNTED: "plug.state.unmounted",
};

function ConfigField({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: JsonSchemaNode;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const t = useT();
  const label = schema.description ? t("plug.field.withName", { desc: schema.description, name }) : name;
  if (schema.type === "boolean") {
    return (
      <label className="air-plugin-field">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    );
  }
  if (schema.type === "string" && schema.enum) {
    return (
      <label className="air-plugin-field">
        {label}
        <select value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("plug.field.defaultOption")}</option>
          {schema.enum.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (schema.type === "number" || schema.type === "integer") {
    return (
      <label className="air-plugin-field">
        {label}
        <input
          type="number"
          value={typeof value === "number" ? value : ""}
          min={schema.minimum}
          max={schema.maximum}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      </label>
    );
  }
  return (
    <label className="air-plugin-field">
      {label}
      <input
        type="text"
        value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function PluginRow({
  entry,
  plugins,
  permissions,
  onChanged,
  onNote,
}: {
  entry: PluginStatus;
  plugins: PluginsService;
  permissions?: PermissionsService;
  /** 改完之后让整张面板重新取一次列表（列表是快照，不是订阅 —— 不叫它就会显示旧状态） */
  onChanged: () => void;
  /** 给用户看的一句话结果（放在面板层，行组件刷新时会重挂，局部 state 存不住） */
  onNote: (text: string) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  /** 剪贴板不可用时，把导出的包显示出来让用户手动复制 */
  const [exportText, setExportText] = useState("");
  const [draft, setDraft] = useState<Record<string, unknown>>(
    () => ({ ...((plugins.configOf(entry.id) as Record<string, unknown>) ?? {}) }),
  );
  const manifest = plugins.manifestOf(entry.id);
  // config 在 manifest 校验阶段已经限定为 object schema（见 manifest.ts），这里再收窄一次类型
  const schema = manifest?.config && manifest.config.type === "object" ? manifest.config : undefined;
  const declared = (manifest?.capabilities ?? []) as string[];
  const grantedRecords = permissions?.list(entry.id) ?? [];
  const needsPermission = entry.state === "PENDING_PERMISSION";
  const askPermissions = declared.filter(
    (c) => !grantedRecords.some((r) => r.capability === c && r.state === "granted"),
  );

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    onNote("");
    try {
      await fn();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
      // 面板上的列表来自 plugins.list() 的快照：任何动作之后都要重新取一次，
      // 否则会显示旧状态（P3.5 实测：安装完成之后那一行还写着"内存中"+ 还挂着安装按钮）
      onChanged();
    }
  };
  /** 安装是**用户的动作**（写文件系统），所以这里问一句；模型没有这个工具 */
  const confirmInstall = () => window.confirm(t("plug.install.confirm", { name: entry.name }));

  return (
    <div className="air-plugin-row" data-state={entry.state}>
      <div className="air-plugin-head">
        <span className={"air-plugin-state air-plugin-state-" + entry.state}>{STATE_LABEL[entry.state] ? t(STATE_LABEL[entry.state]) : entry.state}</span>
        <span className="air-plugin-name">{builtinName(entry.id, entry.name)}</span>
        <span className="air-plugin-ver">
          v{entry.version} ·{" "}
          {entry.source === "builtin"
            ? t("plug.source.builtin")
            : entry.dynamic
              ? t("plug.source.dynamic")
              : t("plug.source.user")}
        </span>
        <span className="air-spacer" />
        {entry.dynamic && (
          <button
            className="air-plugin-btn air-plugin-btn-strong"
            disabled={busy}
            title={t("plug.keep.title")}
            onClick={() => {
              if (!confirmInstall()) return;
              void run(async () => {
                const report = await plugins.install(entry.id);
                onNote(report.detail);
              });
            }}
          >
            {t("plug.keep")}
          </button>
        )}
        {entry.source === "user" && (
          <button
            className="air-plugin-btn"
            disabled={busy}
            title={t("plug.export.title")}
            onClick={() =>
              void run(async () => {
                const bundle = await plugins.exportBundle(entry.id);
                const text = JSON.stringify(bundle, null, 2);
                try {
                  await navigator.clipboard.writeText(text);
                  onNote(t("plug.export.copied", { name: entry.name, n: text.length }));
                } catch {
                  setExportText(text);
                  onNote(t("plug.export.clipboardFailed"));
                }
              })
            }
          >
            {t("plug.export")}
          </button>
        )}
        {!entry.dynamic && entry.source === "user" && (
          <button
            className="air-plugin-btn"
            disabled={busy}
            title={t("plug.delete.title")}
            onClick={() => {
              if (!window.confirm(t("plug.delete.confirm", { name: entry.name }))) return;
              void run(async () => {
                await plugins.uninstall(entry.id);
              });
            }}
          >
            {t("plug.delete")}
          </button>
        )}
        {entry.state !== "UNAVAILABLE" && (
          <button
            className="air-plugin-btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await plugins.setEnabled(entry.id, entry.state === "DISABLED");
              })
            }
          >
            {entry.state === "DISABLED" ? t("plug.enable") : t("plug.disable")}
          </button>
        )}
        {schema && (
          <button className="air-plugin-btn" disabled={busy} onClick={() => setOpen((v) => !v)}>
            {open ? t("plug.config.collapse") : t("plug.config.open")}
          </button>
        )}
      </div>
      <div className="air-plugin-purpose">{builtinPurpose(entry.id, entry.purpose)}</div>

      {needsPermission && permissions && (
        <div className="air-perm-ask">
          <div className="air-perm-title">{t("plug.perm.title")}</div>
          {askPermissions.map((capability) => {
            const info = permissions.list().find((r) => r.capability === capability);
            void info;
            const detail = plugins.capabilities(entry.id).find((c) => c.id === capability);
            return (
              <div key={capability} className="air-perm-item">
                <span className={"air-cap air-cap-" + (detail?.risk ?? "unknown")}>{capability}</span>
                <span className="air-perm-desc">
                  {detail?.description ?? ""}
                  {/* P3.10：网络能力把域名清单摆出来 —— 授权的是"这几个域名"，不是"整个互联网" */}
                  {detail?.origins?.length ? (
                    <span className="air-perm-origins">
                      {capability === "ai.credentials"
                        ? t("plug.perm.credentialsOrigins", { origins: detail.origins.join(" / ") })
                        : t("plug.perm.origins", { origins: detail.origins.join(" / ") })}
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}
          <div className="air-perm-actions">
            <button
              className="air-plugin-btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await permissions.grant(entry.id, entry.version, askPermissions, "once");
                  await plugins.sync();
                })
              }
            >
              {t("plug.perm.grantOnce")}
            </button>
            <button
              className="air-plugin-btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await permissions.grant(entry.id, entry.version, askPermissions, "always");
                  await plugins.sync();
                })
              }
            >
              {t("plug.perm.grantAlways")}
            </button>
            <button
              className="air-plugin-btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await permissions.deny(entry.id, entry.version, askPermissions);
                  await plugins.sync();
                })
              }
            >
              {t("plug.perm.deny")}
            </button>
          </div>
        </div>
      )}

      {grantedRecords.filter((r) => r.state === "granted").length > 0 && permissions && (
        <div className="air-perm-granted">
          {t("plug.perm.grantedLabel")}
          {grantedRecords
            .filter((r) => r.state === "granted")
            .map((r) => (
              <span key={r.capability + r.at} className="air-perm-chip">
                {r.capability}
                {r.mode === "always" ? t("plug.perm.permanent") : ""}
                <button
                  className="air-skill-del"
                  title={t("plug.perm.revokeTitle", { cap: r.capability })}
                  onClick={() =>
                    void run(async () => {
                      await permissions.revoke(entry.id, r.capability);
                      await plugins.sync();
                    })
                  }
                >
                  ×
                </button>
              </span>
            ))}
        </div>
      )}
      {entry.detail && <div className="air-plugin-detail">{entry.detail}</div>}
      {exportText && (
        <textarea className="air-plugin-bundle" readOnly value={exportText} onFocus={(e) => e.currentTarget.select()} />
      )}
      {entry.capabilities.length > 0 && (
        <div className="air-plugin-caps">
          {plugins.capabilities(entry.id).map((cap) => (
            <span key={cap.id} className={"air-cap air-cap-" + cap.risk} title={cap.description}>
              {cap.id}
            </span>
          ))}
        </div>
      )}
      {open && schema && (
        <div className="air-plugin-config">
          {Object.entries(schema.properties).map(([key, sub]) => (
            <ConfigField
              key={key}
              name={key}
              schema={sub}
              value={draft[key]}
              onChange={(v) => setDraft((d) => ({ ...d, [key]: v }))}
            />
          ))}
          <div>
            <button
              className="air-plugin-btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await plugins.reload(entry.id, draft);
                })
              }
            >
              {t("plug.config.save")}
            </button>
            <span className="air-plugin-hint">{t("plug.config.saveHint")}</span>
          </div>
        </div>
      )}
      {error && <div className="air-plugin-error">{error}</div>}
    </div>
  );
}

function PluginSettings({ plugins, permissions }: { plugins?: PluginsService; permissions?: PermissionsService }) {
  const t = useT();
  const [tick, setTick] = useState(0);
  const [rescanning, setRescanning] = useState(false);
  /** 动作结果（例如"已落到插件目录"）：放在面板层才不会被行组件的重挂冲掉 */
  const [note, setNote] = useState("");
  const [pasteMode, setPasteMode] = useState(false);
  const [paste, setPaste] = useState("");
  const [importing, setImporting] = useState(false);
  if (!plugins) return <div className="air-plugin-hint">{t("plug.serviceUnavailable")}</div>;
  const list = plugins.list();
  const report = plugins.scanReport();
  const rejected = report?.rejected ?? [];
  const duplicates = report?.duplicates ?? [];

  return (
    <div className="air-plugin-panel" data-tick={tick}>
      <div className="air-plugin-toolbar">
        <span className="air-plugin-count">
          {t("plug.count", { n: list.length, active: list.filter((p) => p.state === "ACTIVE").length })}
        </span>
        <span className="air-spacer" />
        <button
          className="air-plugin-btn"
          disabled={rescanning}
          onClick={() => {
            setRescanning(true);
            void (async () => {
              try {
                await plugins.sync();
              } catch {
                /* 扫描失败不该让面板崩掉：列表照旧显示上一次结果 */
              } finally {
                setRescanning(false);
                setTick((t) => t + 1);
              }
            })();
          }}
        >
          {rescanning ? t("plug.rescanning") : t("plug.rescan")}
        </button>
        <button className="air-plugin-btn" disabled={importing} onClick={() => setPasteMode((v) => !v)}>
          {pasteMode ? t("plug.paste.collapse") : t("plug.paste.open")}
        </button>
      </div>
      {pasteMode && (
        <div className="air-plugin-paste">
          <textarea
            className="air-plugin-bundle"
            placeholder={t("plug.paste.placeholder")}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
          />
          <div>
            <button
              className="air-plugin-btn air-plugin-btn-strong"
              disabled={importing || !paste.trim()}
              onClick={() => {
                setImporting(true);
                setNote("");
                void (async () => {
                  try {
                    const { bundle, run: result } = await plugins.importBundle(paste);
                    setPaste("");
                    setPasteMode(false);
                    setNote(
                      result.state === "PENDING_PERMISSION"
                        ? t("plug.import.donePending", { name: bundle.name, version: bundle.version, state: result.state })
                        : t("plug.import.done", { name: bundle.name, version: bundle.version, state: result.state }),
                    );
                  } catch (e) {
                    setNote(t("plug.import.failed", { msg: String(e instanceof Error ? e.message : e) }));
                  } finally {
                    setImporting(false);
                    setTick((t) => t + 1);
                  }
                })();
              }}
            >
              {t("plug.import.install")}
            </button>
            <span className="air-plugin-hint">{t("plug.paste.hint")}</span>
          </div>
        </div>
      )}
      <div className="air-plugin-dir" title={plugins.dir()}>
        {t("plug.dir.line", { dir: plugins.dir() || t("plug.dir.unknown") })}
      </div>
      {note && <div className="air-plugin-note">{note}</div>}
      {list.map((entry) => (
        <PluginRow
          key={entry.id + tick}
          entry={entry}
          plugins={plugins}
          permissions={permissions}
          onChanged={() => setTick((t) => t + 1)}
          onNote={setNote}
        />
      ))}
      {rejected.length > 0 && (
        <div className="air-plugin-rejected">
          <strong>{t("plug.rejected.title", { n: rejected.length })}</strong>
          {rejected.map((r) => (
            <div key={r.dir}>
              {t("plug.rejected.line", {
                dir: r.dir,
                issues: r.issues.map((i) => i.field + " " + i.message).join(t("plug.issueSeparator")),
              })}
            </div>
          ))}
        </div>
      )}
      {duplicates.length > 0 && (
        <div className="air-plugin-rejected">
          <strong>{t("plug.dup.title")}</strong>
          {duplicates.map((d) => (
            <div key={d.id + d.dropped}>
              {t("plug.dup.line", { id: d.id, kept: d.kept, dropped: d.dropped })}
            </div>
          ))}
        </div>
      )}
      <div className="air-plugin-hint">
        {t("plug.hostApi", { version: HOST_API_VERSION })}
      </div>
    </div>
  );
}

export const pluginSettingsPlugin: BuiltinPlugin = {
  manifest: {
    id: "app.aireader.plugin-settings",
    // name / purpose 用 getter：语言可能在运行期切换，取词必须等到渲染时（写成 t(...) 会在模块加载时定死）
    get name() {
      return t("plug.builtin.pluginManager");
    },
    get purpose() {
      return t("plug.builtin.pluginManagerPurpose");
    },
    version: "1.0.0",
    apiVersion: HOST_API_VERSION,
    capabilities: ["ui.slot"],
  },
  plugin: {
    name: "plugin-settings",
    inject: ["slots", "plugins"],
    apply(ctx) {
      const slots = ctx.get<SlotsService>("slots");
      const plugins = ctx.get<PluginsService>("plugins");
      const permissions = ctx.get<PermissionsService>("permissions");
      if (!slots || !plugins) return;
      slots.register({
        name: "settings.section",
        id: "plugins",
        order: 50,
        label: t("plug.section.label"),
        component: () => <PluginSettings plugins={plugins} permissions={permissions} />,
      });
    },
  },
};
