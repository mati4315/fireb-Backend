export const isLikeModuleEnabledForContent = (
  modulesConfig: FirebaseFirestore.DocumentData | undefined,
  moduleName: 'news' | 'community'
): boolean => {
  const likesConfig = modulesConfig?.likes ?? {};
  const likesEnabled = likesConfig.enabled ?? true;
  const likesNewsEnabled = likesConfig.newsEnabled ?? true;
  const likesCommunityEnabled = likesConfig.communityEnabled ?? true;

  if (!likesEnabled) return false;
  return moduleName === 'news' ? likesNewsEnabled : likesCommunityEnabled;
};

export const isNotificationsModuleEnabled = (
  modulesConfig: FirebaseFirestore.DocumentData | undefined
): boolean => {
  const notificationsConfig = modulesConfig?.notifications ?? {};
  return notificationsConfig.enabled ?? true;
};

export const isLotteryModuleEnabled = (
  modulesConfig: FirebaseFirestore.DocumentData | undefined
): boolean => {
  const lotteryConfig = modulesConfig?.lottery ?? {};
  return lotteryConfig.enabled ?? true;
};

export const isSecretsModuleEnabled = (
  modulesConfig: FirebaseFirestore.DocumentData | undefined
): boolean => {
  const secretsConfig = modulesConfig?.secrets ?? {};
  return secretsConfig.enabled ?? true;
};
