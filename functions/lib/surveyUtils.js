"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSurveyMaxVotesPerUser = exports.isSurveyActive = exports.SURVEY_COMPLETE_BATCH_SIZE = exports.MAX_SURVEY_OPTIONS_SELECTED = void 0;
exports.MAX_SURVEY_OPTIONS_SELECTED = 10;
exports.SURVEY_COMPLETE_BATCH_SIZE = 200;
const isSurveyActive = (value) => value === 'active';
exports.isSurveyActive = isSurveyActive;
const getSurveyMaxVotesPerUser = (isMultipleChoice, maxVotesRaw) => {
    const parsed = Number(maxVotesRaw);
    return Number.isFinite(parsed)
        ? (isMultipleChoice ? Math.max(2, Math.floor(parsed)) : 1)
        : (isMultipleChoice ? 2 : 1);
};
exports.getSurveyMaxVotesPerUser = getSurveyMaxVotesPerUser;
//# sourceMappingURL=surveyUtils.js.map