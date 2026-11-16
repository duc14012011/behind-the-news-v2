
import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import * as cheerio from "cheerio";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// Đọc nội dung bài báo
async function readArticle(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; BehindTheNews/2.0)"
    }
  });

  if (!response.ok) {
    throw new Error("Không thể truy cập bài báo.");
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  $("script, style, nav, footer, header, iframe, noscript").remove();

  let title = $("meta[property='og:title']").attr("content")
    || $("title").text()
    || $("h1").first().text();

  let description = $("meta[name='description']").attr("content") || "";

  let content = $("article").text()
    || $("main").text()
    || $("body").text();

  content = content.replace(/\s+/g, " ").trim();

  return {
    title: title.trim(),
    description,
    content: content.slice(0, 12000)
  };
}

// Tìm kiếm thông tin đối chiếu bằng Tavily
async function searchNews(query) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: "advanced",
      max_results: 6
    }),
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error("Không thể tìm kiếm thông tin đối chiếu.");
  }

  const data = await response.json();

  return (data.results || []).map(item => ({
    title: item.title,
    url: item.url,
    content: item.content
  }));
}

// Gọi Gemini, tự thử lại khi quá tải
async function analyzeWithGemini(prompt) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const interaction = await ai.interactions.create({
        model: MODEL,
        input: prompt,
        store: false
      });

      if (!interaction.output_text) {
        throw new Error("AI không trả về kết quả.");
      }

      return interaction.output_text;

    } catch (error) {
      lastError = error;

      const message = String(error.message || error);
      const temporaryError =
        /429|500|502|503|504|overload|high demand|temporarily unavailable/i.test(message);

      if (!temporaryError || attempt === 3) {
        break;
      }

      await new Promise(resolve =>
        setTimeout(resolve, attempt * 3000)
      );
    }
  }

  throw lastError;
}

// API kiểm chứng thông tin
app.post("/api/verify", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        error: "Bạn chưa nhập đường link bài báo."
      });
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(url);
    } catch {
      return res.status(400).json({
        error: "Đường link không hợp lệ."
      });
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({
        error: "Chỉ hỗ trợ đường link HTTP hoặc HTTPS."
      });
    }

    if (
      !process.env.GEMINI_API_KEY ||
      !process.env.TAVILY_API_KEY
    ) {
      return res.status(500).json({
        error: "Máy chủ chưa được cấu hình đầy đủ API Key."
      });
    }

    // Bước 1: Đọc bài báo
    const article = await readArticle(parsedUrl.href);

    if (article.content.length < 100) {
      return res.status(422).json({
        error: "Không lấy được đủ nội dung bài báo để kiểm chứng."
      });
    }

    // Bước 2: Tìm kiếm thông tin liên quan
    const searchResults = await searchNews(
      article.title + " " + article.description
    );

    if (searchResults.length === 0) {
      return res.status(422).json({
        error: "Chưa tìm thấy nguồn đối chiếu phù hợp."
      });
    }

    // Bước 3: Phân tích bằng Gemini
    const prompt = `
Bạn là chuyên gia hỗ trợ kiểm chứng thông tin.

Hãy phân tích bài báo và các nguồn đối chiếu dưới đây.

BÀI BÁO GỐC:
Tiêu đề: ${article.title}
Mô tả: ${article.description}
Nội dung: ${article.content}

CÁC NGUỒN ĐỐI CHIẾU:
${JSON.stringify(searchResults, null, 2)}

YÊU CẦU:
1. Tóm tắt thông tin chính của bài báo.
2. So sánh với các nguồn đối chiếu.
3. Chỉ ra điểm trùng khớp và mâu thuẫn.
4. Đánh giá độ tin cậy của nguồn và bằng chứng.
5. Đưa ra kết luận theo một trong các mức:
   - Có cơ sở đáng tin cậy
   - Có thông tin chưa chính xác
   - Chưa đủ bằng chứng để kết luận
6. Giải thích rõ lý do.
7. Không tự bịa nguồn hoặc bằng chứng.
8. Không khẳng định một thông tin là giả chỉ vì chưa tìm thấy nguồn xác nhận.

Trình bày bằng tiếng Việt, rõ ràng, dễ hiểu.

Cuối báo cáo, liệt kê đường link các nguồn đối chiếu đã cung cấp.
`;

    const analysis = await analyzeWithGemini(prompt);

    return res.json({
      success: true,
      article: {
        title: article.title,
        url: parsedUrl.href
      },
      sources: searchResults,
      analysis
    });

  } catch (error) {
    console.error("VERIFY ERROR:", error);

    return res.status(500).json({
      error: "Chưa thể hoàn thành kiểm chứng. " +
        (error.message || "Vui lòng thử lại sau.")
    });
  }
});

// Kiểm tra máy chủ
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    website: "BEHIND THE NEWS 2.0"
  });
});

app.listen(PORT, () => {
  console.log("BEHIND THE NEWS 2.0 đang chạy tại cổng " + PORT);
});
