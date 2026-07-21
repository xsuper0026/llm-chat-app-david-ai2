/**
 * LLM Chat App Frontend
 *
 * Handles the chat UI interactions and communication with the backend API.
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

// Initial welcome message
const INITIAL_MESSAGE = {
  role: "assistant",
  content:
    "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
};

// Chat state
let chatHistory = [{ ...INITIAL_MESSAGE }];
let isProcessing = false;

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Send button click handler
sendButton.addEventListener("click", sendMessage);

// Clear chat button (optional)
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

/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
  const message = userInput.value.trim();

  // Don't send empty messages
  if (message === "" || isProcessing) return;

  // Disable input while processing
  isProcessing = true;
  userInput.disabled = true;
  sendButton.disabled = true;

  // Add user message to chat
  addMessageToChat("user", message);

  // Clear input
  userInput.value = "";
  userInput.style.height = "auto";

  // Show typing indicator
  typingIndicator.classList.add("visible");

  // 記住原始 history 長度，方便失敗時 rollback
  const historyLengthBeforeSend = chatHistory.length;
  chatHistory.push({ role: "user", content: message });

  // Create new assistant response element
  const assistantMessageEl = document.createElement("div");
  assistantMessageEl.className = "message assistant-message";
  assistantMessageEl.innerHTML = "<p></p>";
  chatMessages.appendChild(assistantMessageEl);
  const assistantTextEl = assistantMessageEl.querySelector("p");

  // Scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    // Send request to API
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: chatHistory,
      }),
    });

    // Handle errors
    if (!response.ok) {
      let errorDetail = "HTTP " + response.status + " " + response.statusText;
      try {
        const errorData = await response.json();
        const err =
          typeof errorData.error === "string"
            ? errorData.error
            : JSON.stringify(errorData.error || "");
        const detail =
          typeof errorData.detail === "string"
            ? errorData.detail
            : JSON.stringify(errorData.detail || "");
        errorDetail = (err || "Error") + (detail ? " - " + detail : "") + " (HTTP " + response.status + ")";
      } catch {
        // keep default
      }
      throw new Error(errorDetail);
    }
    if (!response.body) {
      throw new Error("Response body is null");
    }

    // Process streaming response (SSE format)
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
        // Process any remaining events in buffer
        const parsed = consumeSseEvents(buffer + "\n\n");
        for (const data of parsed.events) {
          if (data === "[DONE]") break;
          try {
            const jsonData = JSON.parse(data);
            let content = "";
            if (
              typeof jsonData.response === "string" &&
              jsonData.response.length > 0
            ) {
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

      // Decode chunk and process SSE events
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
          if (
            typeof jsonData.response === "string" &&
            jsonData.response.length > 0
          ) {
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

    // 判斷 AI 是否有回應
    if (responseText.length > 0) {
      chatHistory.push({ role: "assistant", content: responseText });
    } else {
      // 沒回應也算失敗（AI 拒絕但沒回錯誤），rollback 使用者訊息
      chatHistory.length = historyLengthBeforeSend;
      assistantTextEl.textContent = "您問的問題可能違反內容政策，無法回覆。這則訊息已從對話中移除，請重新發問。";
      assistantMessageEl.style.color = "#c0392b";
    }
  } catch (error) {
    console.error("Error:", error);

    // 關鍵修正：失敗時 rollback chatHistory，避免汙染後續對話
    chatHistory.length = historyLengthBeforeSend;

    const errorMessage = serializeError(error);
    assistantTextEl.textContent = "Sorry, 您問的問題有不當文字，請重新發問。（錯誤詳情：" + errorMessage + "）";
    assistantMessageEl.style.color = "#c0392b";
  } finally {
    // Hide typing indicator
    typingIndicator.classList.remove("visible");

    // Re-enable input
    isProcessing = false;
    userInput.disabled = false;
    sendButton.disabled = false;
    userInput.focus();
  }
}

/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content) {
  const messageEl = document.createElement("div");
  messageEl.className = "message " + role + "-message";
  messageEl.innerHTML = "<p></p>";
  messageEl.querySelector("p").textContent = content;
  chatMessages.appendChild(messageEl);

  // Scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * SSE 事件解析器
 * 處理 "data: {...}\n\n" 格式的 Server-Sent Events
 */
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
