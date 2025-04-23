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
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

    // Prepare messages with explicit literal types
    const messages: Array<{ role: "system" | "user"; content: string }> = [
      {
        role: "system",
        content:
          "You are an expert AI researcher and tech journalist who creates DETAILED and COMPREHENSIVE summaries of AI news and technology stories. " +
          "For each story, you MUST provide lengthy, informative summaries that cover key points, implications, context, and potential impact.\n\n" +
          "Return strictly valid JSON that has a key 'interestingTweetsOrStories' containing an array of items. " +
          "Each item MUST have: " +
          "1. 'title_ko' - A concise but informative Korean title/headline.\n" +
          "2. 'description_ko' - A MINIMUM of 3-4 complete sentences in fluent Korean that thoroughly explain the story, its significance, technical details, and broader context. Provide comprehensive information even if the original source is brief.\n" +
          "3. 'story_or_tweet_link' - Link to the source.\n" +
          "4. 'category' - MUST be ONE of these categories exactly as written: '모델 업데이트', '연구 동향', '시장 동향', '개발자 도구'. Choose the most appropriate category based on the content.\n" +
          "5. 'fullContent' - DIRECTLY COPY the ENTIRE content of the article if available in the input. DO NOT modify, summarize or rewrite this content. Preserve ALL paragraphs, line breaks, formatting, and exact wording of the original content. This should be a direct copy-paste from the input, not your own creation.\n" + 
          "6. 'fullContent_ko' - A complete Korean translation of the fullContent field, maintaining the same paragraph structure and formatting as the original.\n" +
          "7. 'imageUrls' - An array of image URLs found in the article if any. If no images, provide an empty array.\n" +
          "8. 'videoUrls' - An array of video URLs found in the article if any. If no videos, provide an empty array.\n\n" +
          "IMPORTANT: description_ko MUST be detailed enough to stand alone as informative summary. DO NOT provide short, one-sentence summaries. For each item, write AT LEAST 3 substantive sentences that fully explain the content and context. If the original content is brief, use your expert knowledge to expand on its implications and details.\n\n" +
          "IMPORTANT: The fullContent field should be EXACTLY as it appears in the input, without ANY changes. This conserves tokens by not having you recreate or modify this content.",
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
      max_tokens: 3500, // 충분한 길이 확보 (1500에서 3000으로 증가)
      // reasoning_effort: "high", // 추론 모델을 쓸 때 ex. o3
      response_format: { "type": "json_object" }, // 명시적으로 JSON 응답 요청
      messages,
      store: true,
    });

    const rawJSON = completion.choices[0].message.content;
    if (!rawJSON) {
      console.log("No JSON output returned from OpenAI.");
      return header + "출력 결과가 없습니다.";
    }
    console.log("Raw OpenAI response:", rawJSON?.substring(0, 200) + "...");

    let parsedResponse;
    try {
      parsedResponse = JSON.parse(rawJSON);
    } catch (error) {
      console.error("Error parsing JSON from OpenAI response:", error);
      // JSON 파싱 실패 시 다양한 정제 시도
      try {
        // 1. JSON 시작과 끝 찾기
        const jsonStart = rawJSON.indexOf('{');
        const jsonEnd = rawJSON.lastIndexOf('}') + 1;
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          let extractedJson = rawJSON.substring(jsonStart, jsonEnd);
          
          // 2. 잘린 URL 및 따옴표 문제 수정
          extractedJson = fixBrokenUrls(extractedJson);
          
          try {
            parsedResponse = JSON.parse(extractedJson);
            console.log("JSON 수정 후 성공적으로 파싱되었습니다.");
          } catch (extractError) {
            console.error("첫 번째 추출 시도 실패:", extractError);
            
            // 3. JSON 문자열 다듬기 시도
            try {
              // 일반적인 JSON 오류 수정
              let cleanedJson = extractedJson
                .replace(/,\s*}/g, '}')  // 객체 끝에 있는 불필요한 쉼표 제거
                .replace(/,\s*]/g, ']')  // 배열 끝에 있는 불필요한 쉼표 제거
                .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":')  // 속성 이름에 따옴표 추가
                .replace(/\\/g, '\\\\');  // 이스케이프되지 않은 백슬래시 수정
                
              parsedResponse = JSON.parse(cleanedJson);
              console.log("정제된 JSON으로 성공적으로 파싱되었습니다.");
            } catch (cleanError) {
              console.error("정제 시도 실패:", cleanError);
              
              // 4. 마지막 수단: 응급 JSON 생성
              parsedResponse = createEmergencyResponse(rawJSON);
              console.log("응급 JSON 객체를 생성했습니다.");
            }
          }
        } else {
          // 5. JSON을 찾을 수 없는 경우 응급 JSON 생성
          parsedResponse = createEmergencyResponse(rawJSON);
          console.log("JSON 구조를 찾을 수 없어 응급 JSON 객체를 생성했습니다.");
        }
      } catch (finalError) {
        console.error("모든 JSON 복구 시도 실패:", finalError);
        return { 
          draft_post: header + "JSON 파싱 오류가 발생했습니다.",
          translatedContent: []
        };
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
      
      // 카테고리가 없거나 유효하지 않은 경우 기본값 설정
      const validCategories = ['모델 업데이트', '연구 동향', '시장 동향', '개발자 도구'];
      if (!item.category || !validCategories.includes(item.category)) {
        // 기본적으로 '연구 동향'으로 설정
        item.category = '연구 동향';
      }
      
      return item;
    });

    // Build the draft post using the content array
    const draft_post =
      header +
      processedContent
        .map(
          (item: any) =>
            `• ${item.description_ko || ""}\n  ${
              item.story_or_tweet_link || item.link
            }`,
        )
        .join("\n\n");

    // Store the original and translated content for Notion
    const translatedContent = processedContent.map((item: any) => ({
      title_ko: item.title_ko || "",                 // title에 해당
      translated: item.description_ko || "",         // content_kr에 해당
      // date
      link: item.story_or_tweet_link || item.link,   // url에 해당
      category: item.category || "연구 동향",          // 카테고리 정보
      content_full: item.fullContent || "",          // 전체 원문 (원본 형식 유지)
      content_full_ko: item.fullContent_ko || "",    // 전체 원문 번역본 (원본 형식 유지)
      image_url: item.imageUrls || [],               // 이미지 URL 배열
      video_url: item.videoUrls || []                // 비디오 URL 배열
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

/**
 * 잘린 URL과 문자열 관련 문제를 수정합니다.
 */
function fixBrokenUrls(jsonStr: string): string {
  // 불완전한 URL 패턴 찾기
  const urlRegex = /"(https?:\/\/[^"\s]*?)(?:"|$)/g;
  
  // 불완전한 URL 수정
  return jsonStr.replace(urlRegex, (match, url) => {
    // URL이 따옴표로 적절히 닫히지 않은 경우
    if (!match.endsWith('"')) {
      return `"${url}"`;
    }
    return match;
  });
}

/**
 * 원시 응답에서 가능한 데이터를 추출하여 응급 JSON 객체를 생성합니다.
 */
function createEmergencyResponse(rawText: string): any {
  console.log("응급 JSON 생성 중...");
  
  try {
    // 기본 응급 객체
    const emergency = {
      interestingTweetsOrStories: [
        {
          description_ko: "OpenAI 응답에서 유효한 JSON을 파싱할 수 없었습니다. API 응답 형식에 문제가 있습니다.",
          title_ko: "JSON 파싱 오류",
          story_or_tweet_link: "https://help.openai.com",
          category: "개발자 도구",
          fullContent: "",
          fullContent_ko: "",
          imageUrls: [] as string[],
          videoUrls: [] as string[]
        }
      ]
    };
    
    // 원시 응답에서 가능한 데이터 추출 시도
    const descriptionKoMatch = /"description_ko"\s*:\s*"(.*?)(?:"|$)/g.exec(rawText);
    const titleKoMatch = /"title_ko"\s*:\s*"(.*?)(?:"|$)/g.exec(rawText);
    const linkMatch = /"story_or_tweet_link"\s*:\s*"(.*?)(?:"|$)/g.exec(rawText);
    const categoryMatch = /"category"\s*:\s*"(.*?)(?:"|$)/g.exec(rawText);
    const fullContentMatch = /"fullContent"\s*:\s*"(.*?)(?:"|$)/g.exec(rawText);
    const fullContentKoMatch = /"fullContent_ko"\s*:\s*"(.*?)(?:"|$)/g.exec(rawText);
    
    // 이미지 URL 배열 추출 시도
    let imageUrls: string[] = [];
    const imageUrlsMatch = /"imageUrls"\s*:\s*\[(.*?)\]/g.exec(rawText);
    if (imageUrlsMatch && imageUrlsMatch[1]) {
      // 배열 내용을 추출해서 분리
      const urlsString = imageUrlsMatch[1];
      // 따옴표로 둘러싸인 URL 추출
      const urlMatches = urlsString.match(/"(https?:\/\/[^"]+)"/g);
      if (urlMatches) {
        imageUrls = urlMatches.map(url => url.replace(/"/g, ''));
      }
    }
    
    // 비디오 URL 배열 추출 시도
    let videoUrls: string[] = [];
    const videoUrlsMatch = /"videoUrls"\s*:\s*\[(.*?)\]/g.exec(rawText);
    if (videoUrlsMatch && videoUrlsMatch[1]) {
      // 배열 내용을 추출해서 분리
      const urlsString = videoUrlsMatch[1];
      // 따옴표로 둘러싸인 URL 추출
      const urlMatches = urlsString.match(/"(https?:\/\/[^"]+)"/g);
      if (urlMatches) {
        videoUrls = urlMatches.map(url => url.replace(/"/g, ''));
      }
    }
    
    // 추출된 데이터가 있으면 응급 객체에 추가
    if (descriptionKoMatch && descriptionKoMatch[1]) {
      emergency.interestingTweetsOrStories[0].description_ko = descriptionKoMatch[1];
    }
    
    if (titleKoMatch && titleKoMatch[1]) {
      emergency.interestingTweetsOrStories[0].title_ko = titleKoMatch[1];
    }
    
    if (linkMatch && linkMatch[1]) {
      // URL이 불완전한 경우 기본 URL로 대체
      const url = linkMatch[1];
      emergency.interestingTweetsOrStories[0].story_or_tweet_link = 
        url.startsWith('http') ? url : "https://www.example.com";
    }
    
    if (categoryMatch && categoryMatch[1]) {
      const validCategories = ['모델 업데이트', '연구 동향', '시장 동향', '개발자 도구'];
      const category = categoryMatch[1];
      emergency.interestingTweetsOrStories[0].category = 
        validCategories.includes(category) ? category : "개발자 도구";
    }
    
    if (fullContentMatch && fullContentMatch[1]) {
      emergency.interestingTweetsOrStories[0].fullContent = fullContentMatch[1];
    }
    
    if (fullContentKoMatch && fullContentKoMatch[1]) {
      emergency.interestingTweetsOrStories[0].fullContent_ko = fullContentKoMatch[1];
    }
    
    if (imageUrls.length > 0) {
      emergency.interestingTweetsOrStories[0].imageUrls = imageUrls;
    }
    
    if (videoUrls.length > 0) {
      emergency.interestingTweetsOrStories[0].videoUrls = videoUrls;
    }
    
    return emergency;
  } catch (error) {
    console.error("응급 JSON 생성 실패:", error);
    // 가장 기본적인 응급 객체 반환
    return {
      interestingTweetsOrStories: [
        {
          description_ko: "OpenAI 응답 처리 중 오류가 발생했습니다.",
          title_ko: "응답 처리 오류",
          story_or_tweet_link: "https://www.example.com",
          category: "개발자 도구",
          fullContent: "",
          fullContent_ko: "",
          imageUrls: [] as string[],
          videoUrls: [] as string[]
        }
      ]
    };
  }
}
