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

    // Prepare messages with explicit literal types
    const messages: Array<{ role: "system" | "user"; content: string }> = [
      {
        role: "system",
        content:
          "You are a helpful assistant that creates a concise, bullet-pointed draft post based on input stories and tweets. " +
          "Return strictly valid JSON that has a key 'interestingTweetsOrStories' containing an array of items. " +
          "Each item should have: " +
          "1. 'description' (English original description), " +
          "2. 'description_ko' (Korean translation of the description), " +
          "3. 'title_ko' (Korean translation of the title if it exists), " +
          "4. 'story_or_tweet_link' (link to the source). " +
          "Make sure to translate all content into natural, fluent Korean.",
      },
      {
        role: "user",
        content: rawStories,
      },
    ];

    // Call the chat completions API using the o3-mini model
    const completion = await openai.chat.completions.create({
      model: "o3-mini",
      reasoning_effort: "medium",
      messages,
      store: true,
    });

    const rawJSON = completion.choices[0].message.content;
    if (!rawJSON) {
      console.log("No JSON output returned from OpenAI.");
      return header + "출력 결과가 없습니다.";
    }
    console.log(rawJSON);

    const parsedResponse = JSON.parse(rawJSON);

    // Check for either key and see if we have any content
    const contentArray =
      parsedResponse.interestingTweetsOrStories || parsedResponse.stories || [];
    if (contentArray.length === 0) {
      return header + "현재 트렌딩 중인 이야기나 트윗이 발견되지 않았습니다.";
    }

    // Build the draft post using the content array
    const draft_post =
      header +
      contentArray
        .map(
          (item: any) =>
            `• ${item.description || item.headline}\n  ${
              item.story_or_tweet_link || item.link
            }`,
        )
        .join("\n\n");

    return draft_post;
  } catch (error) {
    console.error("Error generating draft post", error);
    return "Error generating draft post.";
  }
}
