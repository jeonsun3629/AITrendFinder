import { scrapeSources } from "../services/scrapeSources";
import { getCronSources } from "../services/getCronSources";
import { generateDraft } from "../services/generateDraft";
import { sendDraft } from "../services/sendDraft";

export const handleCron = async (): Promise<void> => {
  try {
    const cronSources = await getCronSources();
    console.log("모든 소스 목록:", cronSources.map(s => s.identifier));
    const rawStories = await scrapeSources(cronSources);
    const rawStoriesString = JSON.stringify(rawStories);
    const draftResult = await generateDraft(rawStoriesString);
    const result = await sendDraft(draftResult!);
    console.log(result);
  } catch (error) {
    console.error(error);
  }
};
