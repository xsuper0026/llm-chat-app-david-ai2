/**
 * LLM Chat App Frontend
 *
 * Handles the chat UI interactions and communication with the backend API.
 */

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

const INITIAL_MESSAGE = {
  role: "assistant",
  content:
    "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
};

let chatHistory = [{ ...INITIAL_MESSAGE }];
let isProcessing = false;

userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = this.scrollHeight + "px";
});

userInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendButton.addEventListener("click", sendMessage);

const clearButton = document.getElementById("clear-button");
if (clearButton) {
  clearButton.addEventListener("click", clearChat);
}

function clearChat() {
  chatHistory = [{ ...INITIAL_MESSAGE }];
  chatMessages.innerHTML = "";
  addMessageToChat("assistant", INITIAL_MESSAGE.content);
  userInput.focus();
}

function serializeError(error) {
  if (error instanceof Error) {
    return error.message || error.name || "Error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

// 統一處理「被擋 / 失敗」：把該則移出歷史，顯示紅字提示
function markBlocked(assistantMessageEl, assistantTextEl, historyLengthBeforeSend, text) {
  chatHistory.length = historyLengthBeforeSend;
  assistantTextEl.textContent = text;
  assistantMessageEl.style.color = "#c0392b";
}

async function sendMessage() {
  const message = userInput.value.trim();
  if (message === "" || isProcessing) return;

  isProcessing = true;
  userInput.disabled = true;
  sendButton.disabled = true;

  addMessageToChat("user", message);

  userInput.value = "";
  userInput.style.height = "auto";

  typingIndicator.classList.add("visible");

  const historyLengthBeforeSend = chatHistory.length;
  chatHistory.push({ role: "user", content: message });

  const assistantMessageEl = document.createElement("div");
  assistantMessageEl.className = "message assistant-message";
  assistantMessageEl.innerHTML = "<p></p>";
  chatMessages.appendChild(assistantMessageEl);
  const assistantTextEl = assistantMessageEl.querySelector("p");

  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatHistory }),
    });

    // ⭐ WAF 攔截通常回 403（或其他非 2xx），且 body 多為 HTML 攔截頁面而非 JSON。
    // 只要不是 2xx，一律當成被擋：移出歷史，讓後續問題不受影響。
    if (!response.ok) {
      let hint = "";
      if (response.status === 403) {
        hint = "（此訊息含有被防火牆攔截的內容）";
      } else {
        hint = "（HTTP " + response.status + "）";
      }
      markBlocked(
        assistantMessageEl,
        assistantTextEl,
        historyLengthBeforeSend,
        "您問的問題可能含有不當內容，已被攔截。這則訊息已從對話中移除，請重新發問。" + hint
      );
      return;
    }

    if (!response.body) {
      markBlocked(
        assistantMessageEl,
        assistantTextEl,
        historyLengthBeforeSend,
        "沒有收到回應內容，這則訊息已從對話中移除，請重新發問。"
      );
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let responseText = "";
    let buffer = "";

    const flushAssistantText = () => {
      assistantTextEl.textContent = responseText;
      chatMessages.scrollTop = chatMessages.scrollHeight;
    };

    let sawDone = false;
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        const parsed = consumeSseEvents(buffer + "\n\n");
        for (const data of parsed.events) {
          if (data === "[DONE]") break;
          try {
            const jsonData = JSON.parse(data);
            let content = "";
            if (typeof jsonData.response === "string" && jsonData.response.length > 0) {
              content = jsonData.response;
            } else if (
              jsonData.choices &&
              jsonData.choices[0] &&
              jsonData.choices[0].delta &&
              jsonData.choices[0].delta.content
            ) {
              content = jsonData.choices[0].delta.content;
            }
            if (content) {
              responseText += content;
              flushAssistantText();
            }
          } catch (e) {
            console.error("Error parsing SSE data as JSON:", e, data);
          }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parsed = consumeSseEvents(buffer);
      buffer = parsed.buffer;

      for (const data of parsed.events) {
        if (data === "[DONE]") {
          sawDone = true;
          buffer = "";
          break;
        }
        try {
          const jsonData = JSON.parse(data);
          let content = "";
          if (typeof jsonData.response === "string" && jsonData.response.length > 0) {
            content = jsonData.response;
          } else if (
            jsonData.choices &&
            jsonData.choices[0] &&
            jsonData.choices[0].delta &&
            jsonData.choices[0].delta.content
          ) {
            content = jsonData.choices[0].delta.content;
          }
          if (content) {
            responseText += content;
            flushAssistantText();
          }
        } catch (e) {
          console.error("Error parsing SSE data as JSON:", e, data);
        }
      }
      if (sawDone) break;
    }

    if (responseText.length > 0) {
      chatHistory.push({ role: "assistant", content: responseText });
    } else {
      markBlocked(
        assistantMessageEl,
        assistantTextEl,
        historyLengthBeforeSend,
        "您問的問題可能違反內容政策，無法回覆。這則訊息已從對話中移除，請重新發問。"
      );
    }
  } catch (error) {
    console.error("Error:", error);
    markBlocked(
      assistantMessageEl,
      assistantTextEl,
      historyLengthBeforeSend,
      "抱歉，這則訊息處理失敗（可能含有被攔截的內容）。這則訊息已從對話中移除，請重新發問。（錯誤詳情：" +
        serializeError(error) +
        "）"
    );
  } finally {
    typingIndicator.classList.remove("visible");
    isProcessing = false;
    userInput.disabled = false;
    sendButton.disabled = false;
    userInput.focus();
  }
}

function addMessageToChat(role, content) {
  const messageEl = document.createElement("div");
  messageEl.className = "message " + role + "-message";
  messageEl.innerHTML = "<p></p>";
  messageEl.querySelector("p").textContent = content;
  chatMessages.appendChild(messageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function consumeSseEvents(buffer) {
  let normalized = buffer.replace(/\r/g, "");
  const events = [];
  let eventEndIndex;
  while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
    const rawEvent = normalized.slice(0, eventEndIndex);
    normalized = normalized.slice(eventEndIndex + 2);

    const lines = rawEvent.split("\n");
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    events.push(dataLines.join("\n"));
  }
  return { events, buffer: normalized };
}
