export const canEditPost = (thread, me, { canEditOthers = false } = {}) =>
  !!thread && !!me && (thread.createdBy?.id === me.id || !!canEditOthers || !!me.canEditAnyMessage);

export const canDeletePost = (thread, me, { canManage = false } = {}) =>
  (!!thread && !!me && thread.createdBy?.id === me.id) || !!canManage || !!me?.isSiteAdmin;
