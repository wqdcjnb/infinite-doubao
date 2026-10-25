"use strict";

// Native modal dialogs keep keyboard focus and embedded account pages behind the overlay.
(() => {
  const sessions = new WeakMap();
  let confirming = false;

  function close(dialog) {
    if (!dialog.open) return;
    const session = sessions.get(dialog);
    dialog.close();
    dialog.classList.add("hidden");
    if (session?.remove) dialog.remove();
    if (session?.trigger?.isConnected) session.trigger.focus();
    session?.onClose?.();
  }

  function open(dialog, options = {}) {
    if (dialog.open) return;
    if (!sessions.has(dialog)) {
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(dialog); });
      // A drag starting in the content must not dismiss the dialog on release outside it.
      let outside = false;
      dialog.addEventListener("pointerdown", (event) => { outside = event.target === dialog; });
      dialog.addEventListener("click", (event) => {
        if (outside && event.target === dialog) close(dialog);
        outside = false;
      });
    }
    sessions.set(dialog, { ...options, trigger: document.activeElement });
    dialog.classList.remove("hidden");
    dialog.showModal();
    (options.focus || dialog.querySelector("button, input, select, textarea"))?.focus();
  }

  function confirm({ title, message, subject, detail, confirmLabel = "确定", danger = false }) {
    if (confirming) return Promise.resolve(false);
    confirming = true;
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.id = "confirmDialog";
      dialog.className = "modal-mask";
      dialog.setAttribute("aria-labelledby", "confirmTitle");
      dialog.setAttribute("aria-describedby", "confirmMessage");
      dialog.innerHTML = `<div class="modal confirm-dialog${danger ? " is-danger" : ""}">
        <div class="confirm-top"><span class="dialog-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${danger
            ? '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/>'
            : '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"/>'}</svg>
        </span><button class="dialog-close" aria-label="关闭弹窗">×</button></div>
        <div class="modal-body confirm-body"><h2 id="confirmTitle"></h2><p id="confirmMessage"></p>
          <div class="confirm-subject" hidden></div><p class="confirm-detail" hidden></p></div>
        <div class="modal-foot"><button class="ghost" id="confirmCancel">取消</button>
          <button class="${danger ? "danger-solid" : "primary"}" id="confirmAccept"></button></div>
      </div>`;
      const q = (selector) => dialog.querySelector(selector);
      q("#confirmTitle").textContent = title;
      q("#confirmMessage").textContent = message;
      q("#confirmAccept").textContent = confirmLabel;
      if (subject) { q(".confirm-subject").textContent = subject; q(".confirm-subject").hidden = false; }
      if (detail) { q(".confirm-detail").textContent = detail; q(".confirm-detail").hidden = false; }
      let accepted = false;
      q(".dialog-close").addEventListener("click", () => close(dialog));
      q("#confirmCancel").addEventListener("click", () => close(dialog));
      q("#confirmAccept").addEventListener("click", () => { accepted = true; close(dialog); });
      document.body.appendChild(dialog);
      open(dialog, { focus: q("#confirmCancel"), remove: true, onClose: () => { confirming = false; resolve(accepted); } });
    });
  }

  window.DMDialogs = { open, close, confirm };
})();
