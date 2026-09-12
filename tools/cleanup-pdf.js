(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const pdfs = await inv("db_select", { sql: "SELECT id, path, original_name FROM books WHERE format = ?", params: ["pdf"] });
  for (const p of pdfs) {
    try { await inv("delete_book_file", { path: p.path }); } catch (e) { /* 文件可能不存在 */ }
  }
  await inv("db_execute", { sql: "DELETE FROM books WHERE format = ?", params: ["pdf"] });
  return { removed: pdfs.map((p) => p.original_name) };
})()