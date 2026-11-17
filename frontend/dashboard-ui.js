(() => {
  "use strict";

  const header = document.querySelector(".app-header");
  const navToggle = document.querySelector(".nav-toggle");
  if (header && navToggle) {
    const setOpen = (open) => {
      header.dataset.navOpen = String(open);
      navToggle.setAttribute("aria-expanded", String(open));
      navToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    };
    navToggle.addEventListener("click", () => setOpen(navToggle.getAttribute("aria-expanded") !== "true"));
    header.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && header.dataset.navOpen === "true") {
        setOpen(false);
        navToggle.focus();
      }
    });
  }

  // Keep native constraint validation, but present its errors beside the field.
  let errorSequence = 0;
  let firstInvalid = null;
  const requiredMessages = {
    smsDeviceId: "Choose a sender device.",
    smsDestination: "Enter a recipient number.",
    smsBody: "Enter a message.",
    serviceName: "Enter a service name.",
    messageTemplate: "Enter a sample message.",
    service: "Enter a service name.",
    id: "Enter an order ID."
  };
  document.addEventListener("invalid", (event) => {
    const control = event.target;
    if (!(control instanceof HTMLElement)) return;
    event.preventDefault();
    if (!control.dataset.uiError) {
      const id = `field-error-${++errorSequence}`;
      const error = document.createElement("span");
      error.className = "field-error";
      error.id = id;
      const field = control.closest(".sms-field, .field, .request-fields label");
      if (field) field.append(error);
      else control.after(error);
      control.dataset.uiError = id;
      control.setAttribute("aria-describedby", [control.getAttribute("aria-describedby"), id].filter(Boolean).join(" "));
    }
    control.setAttribute("aria-invalid", "true");
    const error = document.getElementById(control.dataset.uiError);
    error.textContent = control.validity.valueMissing
      ? requiredMessages[control.id || control.name] || "Complete this field."
      : control.validationMessage;
    if (!firstInvalid) {
      firstInvalid = control;
      setTimeout(() => {
        firstInvalid?.focus();
        firstInvalid = null;
      }, 0);
    }
  }, true);
  const removeFieldError = (control) => {
    if (!control.dataset?.uiError) return;
    const errorId = control.dataset.uiError;
    document.getElementById(errorId)?.remove();
    control.removeAttribute("aria-invalid");
    const description = (control.getAttribute("aria-describedby") || "").split(" ").filter((id) => id !== errorId).join(" ");
    if (description) control.setAttribute("aria-describedby", description);
    else control.removeAttribute("aria-describedby");
    delete control.dataset.uiError;
  };
  const clearFieldError = (event) => {
    const control = event.target;
    if (control.validity?.valid) removeFieldError(control);
  };
  document.addEventListener("input", clearFieldError);
  document.addEventListener("change", clearFieldError);
  document.addEventListener("reset", (event) => {
    event.target.querySelectorAll("[data-ui-error]").forEach(removeFieldError);
  });

  let dialogActive = false;
  window.dashboardUI = {
    confirm({ title, description, fields = [], message, confirmLabel = "Confirm", danger = false }) {
      if (dialogActive) return Promise.resolve(false);
      dialogActive = true;
      const trigger = document.activeElement;
      const dialog = document.createElement("dialog");
      dialog.className = "ui-dialog";
      dialog.setAttribute("aria-labelledby", "confirmation-title");
      dialog.setAttribute("aria-describedby", "confirmation-description");
      dialog.innerHTML = `
        <form method="dialog">
          <div class="dialog-header">
            <h2 id="confirmation-title"></h2>
            <button class="quiet icon-button" value="cancel" aria-label="Close dialog" type="submit" formnovalidate>
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
            </button>
          </div>
          <div class="dialog-content">
            <p class="dialog-description" id="confirmation-description"></p>
          </div>
          <div class="dialog-footer">
            <button class="secondary" value="cancel" type="submit" autofocus>Cancel</button>
            <button class="dialog-confirm" value="confirm" type="submit"></button>
          </div>
        </form>`;
      dialog.querySelector("h2").textContent = title;
      dialog.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(dialog.querySelectorAll("button:not(:disabled)"));
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
      dialog.querySelector(".dialog-description").textContent = description;
      const confirm = dialog.querySelector(".dialog-confirm");
      confirm.textContent = confirmLabel;
      if (danger) confirm.classList.add("danger", "primary");
      const content = dialog.querySelector(".dialog-content");
      if (fields.length) {
        const list = document.createElement("dl");
        list.className = "dialog-fields";
        fields.forEach(([label, value]) => {
          const term = document.createElement("dt");
          const detail = document.createElement("dd");
          term.textContent = label;
          detail.textContent = String(value);
          list.append(term, detail);
        });
        content.append(list);
      }
      if (message) {
        const preview = document.createElement("p");
        preview.className = "dialog-message";
        preview.textContent = message;
        content.append(preview);
      }
      document.body.append(dialog);
      return new Promise((resolve) => {
        dialog.addEventListener("close", () => {
          const accepted = dialog.returnValue === "confirm";
          dialog.remove();
          dialogActive = false;
          if (trigger?.isConnected) trigger.focus();
          resolve(accepted);
        }, { once: true });
        dialog.showModal();
      });
    }
  };
})();
