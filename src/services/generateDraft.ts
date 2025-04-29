import OpenAI from "openai";
import dotenv from "dotenv";
import { ApiCache, withCache, getCacheItem, setCacheItem } from "../utils/apiCache";
import NodeCache from 'node-cache';
import { retry as withRetry, RetryConfig } from 'ts-retry-promise';
import { z } from 'zod';
import axios from 'axios';
import type { Story } from './scrapeSources';

dotenv.config();

// 캐시 인스턴스 생성
const cache = new NodeCache({ stdTTL: 24 * 60 * 60 }); // 24시간 캐시

/**
 * OpenAI API를 사용하여 텍스트를 번역합니다.
 */
async function translateTextCore(
  openai: OpenAI,
  text: string,
  model: string,
  isTitle: boolean = false
): Promise<string> {
  if (!text || text.trim() === "") {
    return "";
  }

  try {
    // 제목인 경우 간단한 번역 요청
    if (isTitle) {
      const titleResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "영어 제목을 한국어로 번역해주세요. JSON 형식으로 번역된 내용만 반환합니다. 형식: {\"translated\": \"번역된 텍스트\"}"
          },
          {
            role: "user", 
            content: text
          }
        ],
        temperature: 0.3,
        response_format: { type: "json_object" }
      });
      
      // JSON 응답 파싱
      const titleContent = titleResponse.choices[0]?.message?.content || "";
      try {
        const parsedContent = JSON.parse(titleContent);
        return parsedContent.translated || text;
      } catch (parseError) {
        console.error("Error parsing title translation response:", parseError);
        return text;
      }
    } 
    // 본문인 경우 마크다운 요소를 유지하며 번역
    else {
      const contentResponse = await openai.chat.completions.create({
        model: model,
        temperature: 0.3,
        max_tokens: 4000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: 
              "원문의 모든 마크다운 요소(헤더, 목록, 인용, 코드 블록, 표, 이미지 및 비디오 링크 등)를 그대로 유지하며 한국어로 번역하세요. " +
              "이미지 및 비디오 태그(`![alt](URL)` 또는 URL 삽입)는 본분에 있는 것을 손상되지 않도록 가져와야 합니다. " +
              "응답은 JSON 형식으로, 'translation' 필드에 전체 번역 결과(마크다운 포함)를 포함해주세요."
          },
          {
            role: "user",
            content: `다음 영어 텍스트를 한국어로 번역하세요:\n\n${text.substring(0, 8000)}`
          }
        ]
      });
      
      // 번역 결과 파싱
      const translationContent = contentResponse.choices[0].message.content;
      try {
        if (translationContent) {
          const translationData = JSON.parse(translationContent);
          return translationData.translation || "";
        }
      } catch (parseError) {
        console.error("Error parsing translation response:", parseError);
      }
    }
  } catch (error) {
    console.error(`Error translating ${isTitle ? "title" : "content"}:`, error);
  }
  
  return text; // 오류 발생 시 원본 반환
}

// 캐싱을 적용한 번역 함수
const translateText = withCache(translateTextCore, 'translateText', 24 * 60 * 60 * 1000); // 24시간 캐시

/**
 * 텍스트를 불렛포인트로 요약합니다 (이미 번역된 텍스트일 수 있음).
 */
async function createBulletPointSummaryCore(
  openai: OpenAI,
  text: string,
  model: string,
  alreadyTranslated: boolean = true
): Promise<string> {
  if (!text || text.trim() === "") {
    return "";
  }
  
  try {
    console.log(`Creating bullet point summary (${alreadyTranslated ? "already translated" : "needs translation"})`);
    
    const systemPrompt = alreadyTranslated
      ? "긴 한국어 텍스트 내용을 정확히 10개의 핵심 불렛포인트로 요약하세요. 각 불렛포인트는 한 문장으로 구성되어야 합니다. 원문의 핵심 정보와 중요한 데이터를 최대한 포함하세요. JSON 형식으로 'bullet_points' 필드에 배열로 응답하세요."
      : `
         다음 영어 본문을 분석하고 핵심 내용을 정확히 10개의 bullet point로 요약한 후 한국어로 번역해주세요.
         각 bullet point는 '• ' 기호로 시작해야 합니다.
         핵심 내용, 주요 주장, 중요한 데이터, 결론 등을 포함해야 합니다.
         간결하면서도 정보가 풍부하게 작성해주세요.
         모든 내용은 한국어로 번역되어야 합니다.
         결과는 10개의 bullet point로만 제공하세요.
       `;
       
    // 이미 번역된 텍스트는 JSON으로 응답 요청, 그렇지 않으면 일반 텍스트 응답
    const responseFormat = alreadyTranslated
      ? { type: "json_object" as const }
      : undefined;
    
    const userPrompt = alreadyTranslated
      ? `다음 텍스트를 10개의 불렛포인트로 요약하세요:\n\n${text.substring(0, 15000)}`
      : text.substring(0, 15000);
    
    const bulletSummaryCompletion = await openai.chat.completions.create({
      model: model,
      temperature: 0.5,
      max_tokens: 2000,
      response_format: responseFormat,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userPrompt
        }
      ]
    });
    
    const bulletContent = bulletSummaryCompletion.choices[0].message.content?.trim() || '';
    
    if (alreadyTranslated) {
      try {
        const bulletData = JSON.parse(bulletContent);
        if (Array.isArray(bulletData.bullet_points) && bulletData.bullet_points.length > 0) {
          // 불렛포인트 형식으로 변환
          return bulletData.bullet_points.map((point: string) => `• ${point}`).join('\n\n');
        }
      } catch (parseError) {
        console.error("Error parsing bullet point summary response:", parseError);
      }
    } else {
      // 이미 불렛포인트 형식으로 응답된 경우 그대로 반환
      return bulletContent;
    }
  } catch (error) {
    console.error("Error creating bullet point summary:", error);
  }
  
  return "요약을 생성할 수 없습니다.";
}

// 캐싱을 적용한 불렛포인트 요약 함수
const createBulletPointSummary = withCache(createBulletPointSummaryCore, 'bulletPointSummary', 24 * 60 * 60 * 1000);

/**
 * 한국어 텍스트를 3-4문장으로 간략하게 요약합니다.
 */
async function createBriefSummaryCore(
  openai: OpenAI,
  text: string,
  model: string
): Promise<string> {
  if (!text || text.trim() === "") {
    return "";
  }
  
  try {
    console.log("Creating brief summary...");
    const summaryCompletion = await openai.chat.completions.create({
      model: model,
      temperature: 0.5,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "한국어로 된 텍스트를 3-4개의 문장으로 요약하세요. 핵심 내용을 정확하고 자세하게 포함해야 합니다. JSON 형식으로 응답하되, 'summary' 필드에 요약된 내용을 포함하세요."
        },
        {
          role: "user",
          content: `다음 한국어 텍스트를 3-4문장으로 요약하세요:\n\n${text.substring(0, 6000)}`
        }
      ]
    });
    
    // 요약 결과 파싱
    const summaryContent = summaryCompletion.choices[0].message.content;
    if (summaryContent) {
      try {
        const summaryData = JSON.parse(summaryContent);
        return summaryData.summary || "";
      } catch (parseError) {
        console.error("Error parsing summary response:", parseError);
      }
    }
  } catch (error) {
    console.error("Error creating brief summary:", error);
  }
  
  return "요약을 생성할 수 없습니다.";
}

// 캐싱을 적용한 간략 요약 함수
const createBriefSummary = withCache(createBriefSummaryCore, 'briefSummary', 24 * 60 * 60 * 1000);

/**
 * Process a batch of translations using OpenAI
 */
async function processBatchTranslations(
  stories: any[],
  system_prompt: string
): Promise<any[]> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    // Check if we have content to translate
    if (!stories || stories.length === 0) {
      console.warn("No stories provided for translation");
      return [];
    }

    console.log(`Translating ${stories.length} stories`);

    // Create cache key only with necessary information to avoid circular reference
    const getCacheKey = (story: any) => {
      // 원본 객체에서 필요한 정보만 추출하여 순환 참조 방지
      const cacheData = {
        headline: story.headline || '',
        link: story.link || '',
        fullContent: story.fullContent ? story.fullContent.substring(0, 100) : '', // 전체 콘텐츠 대신 일부만 포함
        date_posted: story.date_posted || ''
      };
      return JSON.stringify(cacheData);
    };

    // Process each story in the batch
    const results = await Promise.all(
      stories.map(async (story) => {
        // 기본 속성 확인 및 설정
        story.headline = story.headline || '제목 없음';
        story.link = story.link || '';
        
        if (!story.fullContent) {
          console.warn(
            `Story missing content: ${story.headline} - using headline only`
          );
          
          // 헤드라인이 있으면 헤드라인을 내용으로 사용, 없으면 기본 메시지
          story.fullContent = story.headline && story.headline.trim() !== "" 
            ? story.headline 
            : "내용을 찾을 수 없습니다. 원본 링크를 확인하세요.";
          
          // 헤드라인이 매우 짧은 경우 (5글자 미만) 추가 경고
          if (story.fullContent.length < 5) {
            console.warn(`경고: 매우 짧은 콘텐츠 (${story.fullContent.length}자): ${story.fullContent}`);
          }
        }

        try {
          // Create cache key for this story
          const cacheKey = getCacheKey(story);

          // Check cache first
          const cachedTranslation = cache.get(`translation:${cacheKey}`);
          if (cachedTranslation) {
            console.log(`Using cached translation for: ${story.headline}`);
            story.fullContent_kr = cachedTranslation;
            return story;
          }

          // Perform translation for this story
          const storyContent = story.fullContent ? story.fullContent.substring(0, 10000) : ''; // Limit length to avoid token limits
          console.log(
            `Translating story: ${story.headline} (${storyContent.length} chars)`
          );

          const translationResult = await withRetry(
            async () => {
              const chatCompletion = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
                messages: [
                  { role: "system", content: system_prompt },
                  { role: "user", content: storyContent },
                ],
              });

              return chatCompletion.choices[0]?.message?.content || "";
            },
            {
              retries: 3,
              timeout: 10000, // minTimeout, maxTimeout 대신 timeout 사용
            }
          );

          // Update story with translation and cache it
          story.fullContent_kr = translationResult;
          
          // Cache the translation with the unique key
          cache.set(`translation:${cacheKey}`, translationResult);
          
          return story;
        } catch (error) {
          console.error(`Error translating story: ${story.headline}`, error);
          // 에러 타입 처리 개선
          const errorMessage = error instanceof Error ? error.message : String(error);
          story.fullContent_kr = `번역 오류: ${errorMessage}`;
          return story;
        }
      })
    );

    console.log(`Successfully processed ${results.length} translations`);
    return results;
  } catch (error) {
    console.error("Error in batch translation process:", error);
    throw error;
  }
}

/**
 * 여러 텍스트에 대한 불렛포인트 요약을 배치로 처리
 */
async function processBatchBulletPointSummaries(
  openai: OpenAI,
  items: { text: string; isTranslated: boolean }[],
  model: string
): Promise<string[]> {
  // 캐시된 항목 확인 및 처리
  const results: string[] = [];
  const uncachedItems: { index: number; text: string; isTranslated: boolean }[] = [];
  
  for (let i = 0; i < items.length; i++) {
    const { text, isTranslated } = items[i];
    const cacheKey = `bulletPointSummary:${JSON.stringify([openai, text, model, isTranslated])}`;
    const cachedResult = getCacheItem<string>(cacheKey);
    
    if (cachedResult !== undefined) {
      results[i] = cachedResult as string;
      console.log(`[캐시 적중] 불렛포인트 요약 #${i}`);
    } else {
      results[i] = ""; // 임시 빈 값
      uncachedItems.push({ index: i, text, isTranslated });
    }
  }
  
  // 캐시되지 않은 항목 병렬 처리
  if (uncachedItems.length > 0) {
    const summaryPromises = uncachedItems.map(async (item) => {
      const summary = await createBulletPointSummaryCore(openai, item.text, model, item.isTranslated);
      results[item.index] = summary;
      
      // 캐시에 저장
      const itemCacheKey = `bulletPointSummary:${JSON.stringify([openai, item.text, model, item.isTranslated])}`;
      setCacheItem(itemCacheKey, summary, 24 * 60 * 60 * 1000);
    });
    
    await Promise.all(summaryPromises);
  }
  
  return results;
}

/**
 * 여러 텍스트에 대한 간략 요약을 배치로 처리
 */
async function processBatchBriefSummaries(
  openai: OpenAI, 
  texts: string[], 
  model: string
): Promise<string[]> {
  // 캐시된 항목 확인 및 처리
  const results: string[] = [];
  const uncachedItems: { index: number; text: string }[] = [];
  
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const cacheKey = `briefSummary:${JSON.stringify([openai, text, model])}`;
    const cachedResult = getCacheItem<string>(cacheKey);
    
    if (cachedResult !== undefined) {
      results[i] = cachedResult as string;
      console.log(`[캐시 적중] 간략 요약 #${i}`);
    } else {
      results[i] = ""; // 임시 빈 값
      uncachedItems.push({ index: i, text });
    }
  }
  
  // 캐시되지 않은 항목 병렬 처리
  if (uncachedItems.length > 0) {
    const summaryPromises = uncachedItems.map(async (item) => {
      const summary = await createBriefSummaryCore(openai, item.text, model);
      results[item.index] = summary;
      
      // 캐시에 저장
      const itemCacheKey = `briefSummary:${JSON.stringify([openai, item.text, model])}`;
      setCacheItem(itemCacheKey, summary, 24 * 60 * 60 * 1000);
    });
    
    await Promise.all(summaryPromises);
  }
  
  return results;
}

/**
 * 원시 스토리 데이터를 가져와 정리하고 번역하여 최종 드래프트를 생성합니다.
 */
export async function generateDraft(rawStories: string) {
  try {
    // 온도 설정 및 API 키 설정
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    
    // 모델 설정
    const model = "gpt-4o";
    
    // 현재 날짜와 시간 (KST)
    const now = new Date();
    const kstDate = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).format(now);
    
    // 헤더
    const header = `🚀 AI 및 LLM 트렌드 (${kstDate})\n\n`;
    
    // 원시 스토리 JSON 파싱
    let stories = [];
    
    try {
      // JSON 구문 분석 오류를 피하기 위해 잘린 URL 및 문자열 처리
      const fixedJsonStr = fixBrokenUrls(rawStories);
      stories = JSON.parse(fixedJsonStr);
      
      if (!Array.isArray(stories)) {
        console.warn(`Stories is not an array, received:`, typeof stories);
        
        // 객체인 경우 stories 속성을 확인
        if (stories && typeof stories === "object" && Array.isArray(stories.stories)) {
          stories = stories.stories;
        } else {
          throw new Error("Invalid stories data format");
        }
      }
    } catch (parseError) {
      console.error("Error parsing raw stories:", parseError);
      
      // 일부라도 JSON을 추출 시도
      try {
        const jsonStartIdx = rawStories.indexOf('{');
        const jsonEndIdx = rawStories.lastIndexOf('}') + 1;
        
        if (jsonStartIdx >= 0 && jsonEndIdx > jsonStartIdx) {
          const jsonSubstr = rawStories.substring(jsonStartIdx, jsonEndIdx);
          const emergency = createEmergencyResponse(jsonSubstr);
          
          if (emergency && Array.isArray(emergency.interestingTweetsOrStories)) {
            stories = emergency.interestingTweetsOrStories;
          }
        }
      } catch (emergencyError) {
        console.error("Failed emergency parsing:", emergencyError);
        return {
          draft_post: header + "JSON 파싱에 실패했습니다. API 응답을 확인해주세요.",
          translatedContent: []
        };
      }
    }
    
    // 스토리가 없거나 유효하지 않은 경우 처리
    if (!stories || stories.length === 0) {
      return {
        draft_post: header + "처리할 스토리가 없습니다.",
        translatedContent: []
      };
    }
    
    console.log(`Found ${stories.length} stories to process`);
    
    // 배치 처리를 위한 준비
    const titleTranslationItems: { text: string; isTitle: boolean }[] = [];
    const contentTranslationItems: { text: string; isTitle: boolean }[] = [];
    
    // 타입 안전성을 위한 기본값 설정 및 배치 처리 준비
    stories.forEach((story: any, index: number) => {
      // 기본값 설정
      story.headline = story.headline || '제목 없음';
      story.fullContent = story.fullContent || '';
      story.imageUrls = story.imageUrls || [];
      story.videoUrls = story.videoUrls || [];
      story.link = story.link || '';
      
      // 카테고리 지정
      const headline = story.headline || "";
      story.category = headline.toLowerCase().includes("research") || 
                       headline.toLowerCase().includes("paper") ? 
                       "연구 동향" : "모델 업데이트";
      
      // 번역 배치 처리를 위한 아이템 추가
      if (headline) {
        titleTranslationItems.push({ text: headline, isTitle: true });
      }
      
      if (story.fullContent && story.fullContent.trim() !== "") {
        contentTranslationItems.push({ text: story.fullContent, isTitle: false });
      }
    });
    
    // 배치 번역 처리
    console.log(`배치 처리 시작: ${titleTranslationItems.length} 제목, ${contentTranslationItems.length} 본문`);
    
    // 제목 번역 배치 처리
    const titleTranslations = await processBatchTranslations(titleTranslationItems, "한국어로 번역해주세요.");
    
    // 본문 번역 배치 처리
    const contentTranslations = await processBatchTranslations(contentTranslationItems, "한국어로 번역해주세요.");
    
    // 번역 결과 스토리에 할당
    let titleIndex = 0;
    let contentIndex = 0;
    
    for (const story of stories) {
      if (story.headline) {
        story.title_ko = titleTranslations[titleIndex++];
      } else {
        story.title_ko = "제목 없음";
      }
      
      if (story.fullContent && story.fullContent.trim() !== "") {
        story.fullContent_ko = contentTranslations[contentIndex++];
      } else {
        story.fullContent_ko = "";
      }
    }
    
    // 요약 배치 처리 준비
    const briefSummaryItems: string[] = [];
    const bulletPointItems: { text: string; isTranslated: boolean }[] = [];
    
    // 요약이 필요한 항목 추가
    for (const story of stories) {
      // story.fullContent_ko가 문자열인지 확인
      const fullContentKo = typeof story.fullContent_ko === 'string' ? story.fullContent_ko : '';
      
      if (fullContentKo && fullContentKo.trim() !== "") {
        briefSummaryItems.push(fullContentKo);
        bulletPointItems.push({ 
          text: typeof story.fullContent === 'string' ? story.fullContent : '', 
          isTranslated: false 
        });
      }
    }
    
    // 배치 요약 처리
    const briefSummaries = await processBatchBriefSummaries(openai, briefSummaryItems, model);
    const bulletPointSummaries = await processBatchBulletPointSummaries(openai, bulletPointItems, model);
    
    // 요약 결과 스토리에 할당
    let briefIndex = 0;
    let bulletIndex = 0;
    
    for (const story of stories) {
      // story.fullContent_ko가 문자열인지 확인
      const fullContentKo = typeof story.fullContent_ko === 'string' ? story.fullContent_ko : '';
      
      if (fullContentKo && fullContentKo.trim() !== "") {
        story.description_ko = briefSummaries[briefIndex++];
        story.content_full_kr = bulletPointSummaries[bulletIndex++];
      } else {
        story.description_ko = "내용 요약을 생성할 수 없습니다.";
        story.content_full_kr = "";
      }
    }
    
    // 최종 결과 생성
    console.log(`모든 스토리 처리 완료: ${stories.length}개`);
    
    // 스토리가 없는 경우 처리
    if (stories.length === 0) {
      return {
        draft_post: header + "현재 트렌딩 중인 이야기나 트윗이 발견되지 않았습니다.",
        translatedContent: []
      };
    }

    // Draft 포스트 빌드
    const draft_post =
      header +
      stories
        .map((story: any) => `• ${story.description_ko}\n  ${story.link}`)
        .join("\n\n");

    // Notion에 보낼 항목 생성
    const translatedContent = stories.map((item: any) => ({
      title_ko: item.title_ko,
      translated: item.description_ko,
      link: item.link,
      category: item.category || "연구 동향",
      content_full: item.fullContent || "",
      content_full_ko: item.fullContent_ko || "",
      content_full_kr: item.content_full_kr || "",
      image_url: item.imageUrls || [],
      video_url: item.videoUrls || []
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
