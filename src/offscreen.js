chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "offscreen-copy" && typeof msg.text === "string") {
    const ok = copy(msg.text);
    sendResponse({ ok });
    return false;
  }
  return false;
});

function copy(text) {
  const ta = document.getElementById("buf");
  ta.value = text;
  ta.select();
  try {
    return document.execCommand("copy");
  } catch (_) {
    return false;
  }
}
