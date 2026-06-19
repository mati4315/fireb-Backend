export type SurveyStatus = 'active' | 'inactive' | 'completed';

export const MAX_SURVEY_OPTIONS_SELECTED = 10;
export const SURVEY_COMPLETE_BATCH_SIZE = 200;

export const isSurveyActive = (value: unknown): boolean => value === 'active';

export const getSurveyMaxVotesPerUser = (
  isMultipleChoice: boolean,
  maxVotesRaw: unknown
): number => {
  const parsed = Number(maxVotesRaw);
  return Number.isFinite(parsed)
    ? (isMultipleChoice ? Math.max(2, Math.floor(parsed)) : 1)
    : (isMultipleChoice ? 2 : 1);
};
