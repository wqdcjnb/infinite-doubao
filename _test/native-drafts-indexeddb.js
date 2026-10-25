// The real site's two draft stores, without credentials or external requests.
window.fixtureDraftStore = (async () => {
  function open(name, store, options) {
    return new Promise((resolve, reject) => {
      const q = indexedDB.open(name, 1);
      q.onupgradeneeded = () => q.result.createObjectStore(store, options);
      q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error);
    });
  }
  const drafts = await open("flow-draft-conversations-v2", "drafts", { keyPath: ["accountScope", "id"] });
  const inputs = await open("samantha-web", "store");
  const scope = "fixture-account", key = "input-engine-draft:v3:account:" + scope;
  const metadata = d => ({ id: d.id, title: d.prompt, scene: d.mode === "云电脑" ? "new-office-task" : "new-chat",
    inputDraftIndex: { accountScope: scope, conversationScope: "local:" + d.id, inputId: "primary" } });
  function write(db, store, update) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite"); update(tx.objectStore(store));
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  }
  async function sync(state) {
    await write(drafts, "drafts", store => {
      store.clear(); for (const d of state.drafts) store.put({ accountScope: scope, id: d.id, data: metadata(d) });
    });
    await write(inputs, "store", store => store.put({ state: { accountScope: scope, records: state.drafts.map(d => ({
      address: metadata(d).inputDraftIndex,
      units: { "input.document": { payload: { format: "plain-text", text: d.prompt } }, "input.attachments": { payload: d.refs } }
    })) } }, key));
  }
  await sync(JSON.parse(localStorage.getItem("fixture")));
  return { sync, metadata };
})();
