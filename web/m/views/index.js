import { registerView } from '../router.js';
import { mountTabs } from './tabs.js';
import { mountPlaceholder } from './placeholder.js';

registerView('tab', mountTabs);
registerView('placeholder', mountPlaceholder);
import { mountChat } from './chat.js';

registerView('chat', mountChat);
import { mountThreads } from './threads.js';

registerView('threads', mountThreads);
import { mountNewMessage } from './newMessage.js';

registerView('newMessage', mountNewMessage);
import { mountFriends } from './friends.js';

registerView('friends', mountFriends);
import { mountSearch } from './search.js';

registerView('search', mountSearch);
import { mountInfo } from './info.js';
import { mountVoice } from './voice.js';

registerView('info', mountInfo);
registerView('voice', mountVoice);
import { mountForum } from './forum.js';

registerView('forum', mountForum);
import { mountNotesScreen, mountSiteScreen } from './desktopViews.js';

registerView('notes', mountNotesScreen);
registerView('site', mountSiteScreen);
import { mountRemoteScreen } from './remoteScreen.js';

registerView('remote', mountRemoteScreen);
