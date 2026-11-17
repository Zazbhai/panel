const loginForm = document.getElementById("loginForm");
const adminKeyInput = document.getElementById("adminKey");
const loginButton = document.getElementById("loginButton");
const loginStatus = document.getElementById("loginStatus");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  loginStatus.textContent = "Signing in...";
  loginStatus.classList.remove("error");

  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: adminKeyInput.value })
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`The server returned an invalid response (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      throw new Error(result && result.error ? result.error : `Sign in failed (HTTP ${response.status}).`);
    }
    window.location.replace("/");
  } catch (error) {
    loginStatus.textContent = error.message;
    loginStatus.classList.add("error");
    adminKeyInput.select();
  } finally {
    loginButton.disabled = false;
  }
});
