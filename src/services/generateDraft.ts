import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

/**
 * Generate a post draft based on scraped raw stories.
 * If no items are found, a fallback message is returned.
 */
export async function generateDraft(rawStories: string) {
  console.log(
    `Generating a post draft with raw stories (${rawStories.length} characters)...`,
  );

  try {
    const currentDate = new Date().toLocaleDateString();
    const header = `🚀 AI 및 LLM 트렌드 (${currentDate})\n\n`;

    // Instantiate the OpenAI client using your OPENAI_API_KEY
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    // 모델 선택 - gpt-4o 또는 o3 권장, 없으면 기본값 사용
    const model = process.env.OPENAI_MODEL || "GPT-4.1 mini";

    // Prepare messages with explicit literal types
    const messages: Array<{ role: "system" | "user"; content: string }> = [
      {
        role: "system",
        content:
          "You are an expert AI researcher and tech journalist who creates DETAILED and COMPREHENSIVE summaries of AI news and technology stories. " +
          "For each story, you MUST provide lengthy, informative summaries that cover key points, implications, context, and potential impact.\n\n" +
          "Return strictly valid JSON that has a key 'interestingTweetsOrStories' containing an array of items. " +
          "Each item MUST have: " +
          "1. 'description' - A MINIMUM of 3-4 complete sentences (NOT bullet points) that thoroughly explain the story, its significance, technical details, and broader context. Provide comprehensive information even if the original source is brief.\n" +
          "2. 'description_ko' - A MINIMUM of 3-4 complete sentences in fluent Korean that provide the same comprehensive information.\n" +
          "3. 'title_ko' - A concise but informative Korean title/headline.\n" +
          "4. 'story_or_tweet_link' - Link to the source.\n\n" +
          "IMPORTANT: Both description and description_ko MUST be detailed enough to stand alone as informative summaries. DO NOT provide short, one-sentence summaries. For each item, write AT LEAST 3 substantive sentences that fully explain the content and context. If the original content is brief, use your expert knowledge to expand on its implications and details.",
      },
      {
        role: "user",
        content: "다음 기사들에 대해 자세하고 포괄적인 설명을 제공해주세요. 각 기사마다 최소 3-4문장 이상의 상세한 요약이 필요합니다:\n\n" + rawStories,
      },
    ];

    // Call the chat completions API with enhanced parameters
    const completion = await openai.chat.completions.create({
      model: model,
      temperature: 0.6, // 약간의 창의성 허용
      max_tokens: 1500, // 충분한 길이 확보
      reasoning_effort: "high", // 높은 추론 노력
      messages,
      store: true,
    });

    const rawJSON = completion.choices[0].message.content;
    if (!rawJSON) {
      console.log("No JSON output returned from OpenAI.");
      return header + "출력 결과가 없습니다.";
    }
    console.log(rawJSON);

    let parsedResponse;
    try {
      parsedResponse = JSON.parse(rawJSON);
    } catch (error) {
      console.error("Error parsing JSON from OpenAI response:", error);
      // JSON 파싱 실패 시 간단한 정제 시도
      const jsonStart = rawJSON.indexOf('{');
      const jsonEnd = rawJSON.lastIndexOf('}') + 1;
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        const extractedJson = rawJSON.substring(jsonStart, jsonEnd);
        try {
          parsedResponse = JSON.parse(extractedJson);
        } catch (error) {
          console.error("Failed to extract valid JSON:", error);
          return header + "JSON 파싱 오류가 발생했습니다.";
        }
      } else {
        return header + "유효한 JSON을 찾을 수 없습니다.";
      }
    }

    // Check for either key and see if we have any content
    const contentArray =
      parsedResponse.interestingTweetsOrStories || parsedResponse.stories || [];
    if (contentArray.length === 0) {
      return header + "현재 트렌딩 중인 이야기나 트윗이 발견되지 않았습니다.";
    }

    // 요약이 너무 짧은 경우 확인 및 보정
    const processedContent = contentArray.map((item: any) => {
      // 요약이 충분히 길고 자세한지 확인
      const koreanDesc = item.description_ko || "";
      const sentences = koreanDesc.split(/[.!?] /).length;
      
      // 너무 짧은 경우 원래 설명에 기본 접미사 추가
      if (sentences < 3 || koreanDesc.length < 100) {
        item.description_ko = koreanDesc + (koreanDesc.endsWith(".") ? " " : ". ") + 
          "(원문이 3문장 이하입니다)";
      }
      
      if (!item.title_ko || item.title_ko.trim() === "") {
        // 제목이 없는 경우 기본 제목 생성
        item.title_ko = "AI 기술 발전: " + koreanDesc.substring(0, 20) + "...";
      }
      
      return item;
    });

    // Build the draft post using the content array
    const draft_post =
      header +
      processedContent
        .map(
          (item: any) =>
            `• ${item.description_ko || item.description || item.headline}\n  ${
              item.story_or_tweet_link || item.link
            }`,
        )
        .join("\n\n");

    // Store the original and translated content for Notion
    const translatedContent = processedContent.map((item: any) => ({
      original: item.description || item.headline,
      translated: item.description_ko || "",
      title_ko: item.title_ko || "",
      link: item.story_or_tweet_link || item.link
    }));

    return { 
      draft_post, 
      translatedContent 
    };
  } catch (error) {
    console.error("Error generating draft post", error);
    return { 
      draft_post: "Error generating draft post.",
      translatedContent: []
    };
  }
}
