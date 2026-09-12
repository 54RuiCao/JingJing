/**
 * i18n 基础类型。
 *
 * 语言分两层：
 *   - LangPref 是**用户的偏好**（可以选"跟随系统"）；
 *   - Lang 是**当下真正生效的语言**，所有 t() 都按它取词。
 */
export type Lang = "zh" | "en";
export type LangPref = Lang | "auto";
/** 插值参数：t("app.importing", { name: "x.epub" }) */
export type Params = Record<string, string | number>;
