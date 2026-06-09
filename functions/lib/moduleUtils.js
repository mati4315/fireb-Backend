"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSecretsModuleEnabled = exports.isLotteryModuleEnabled = exports.isNotificationsModuleEnabled = exports.isLikeModuleEnabledForContent = void 0;
const isLikeModuleEnabledForContent = (modulesConfig, moduleName) => {
    var _a, _b, _c, _d;
    const likesConfig = (_a = modulesConfig === null || modulesConfig === void 0 ? void 0 : modulesConfig.likes) !== null && _a !== void 0 ? _a : {};
    const likesEnabled = (_b = likesConfig.enabled) !== null && _b !== void 0 ? _b : true;
    const likesNewsEnabled = (_c = likesConfig.newsEnabled) !== null && _c !== void 0 ? _c : true;
    const likesCommunityEnabled = (_d = likesConfig.communityEnabled) !== null && _d !== void 0 ? _d : true;
    if (!likesEnabled)
        return false;
    return moduleName === 'news' ? likesNewsEnabled : likesCommunityEnabled;
};
exports.isLikeModuleEnabledForContent = isLikeModuleEnabledForContent;
const isNotificationsModuleEnabled = (modulesConfig) => {
    var _a, _b;
    const notificationsConfig = (_a = modulesConfig === null || modulesConfig === void 0 ? void 0 : modulesConfig.notifications) !== null && _a !== void 0 ? _a : {};
    return (_b = notificationsConfig.enabled) !== null && _b !== void 0 ? _b : true;
};
exports.isNotificationsModuleEnabled = isNotificationsModuleEnabled;
const isLotteryModuleEnabled = (modulesConfig) => {
    var _a, _b;
    const lotteryConfig = (_a = modulesConfig === null || modulesConfig === void 0 ? void 0 : modulesConfig.lottery) !== null && _a !== void 0 ? _a : {};
    return (_b = lotteryConfig.enabled) !== null && _b !== void 0 ? _b : true;
};
exports.isLotteryModuleEnabled = isLotteryModuleEnabled;
const isSecretsModuleEnabled = (modulesConfig) => {
    var _a, _b;
    const secretsConfig = (_a = modulesConfig === null || modulesConfig === void 0 ? void 0 : modulesConfig.secrets) !== null && _a !== void 0 ? _a : {};
    return (_b = secretsConfig.enabled) !== null && _b !== void 0 ? _b : true;
};
exports.isSecretsModuleEnabled = isSecretsModuleEnabled;
//# sourceMappingURL=moduleUtils.js.map