import { App, GenericMessageEvent, KnownEventFromType } from "@slack/bolt";
import { inspect } from "util";
require("dotenv").config();

type EventWithMessage = (
  | KnownEventFromType<"message">
  | GenericMessageEvent
) & {
  client_msg_id: string;
  text: string;
  blocks: any;
};

const app: App = new App({
  token: process.env.BOT_USER_OAUTH_TOKEN,
  signingSecret: process.env.SIGNING_SECRET,
  socketMode: true,
  appToken:
    process.env.APP_TOKEN,
});

const messageStore: {
  [workspaceId: string]: {
    [messageTs: string]: {
      userId: string;
      userAvatar: string;
      message: string;
      event: EventWithMessage;
      channelId: string;
    };
  };
} = {};

const views: string[] = [];

const channelStore: { [workspaceId: string]: { [channelId: string]: any } } =
  {};

const teamStore: { [workspaceId: string]: any } = {};

const addMessageToStore = ({
  event,
  workspaceId,
  userId,
  userAvatar,
}: {
  event: EventWithMessage;
  workspaceId: string;
  userId: string;
  userAvatar?: string;
}) => {
  if (!messageStore[workspaceId]) messageStore[workspaceId] = {};

  messageStore[workspaceId][event.ts] = {
    event: event,
    userId,
    userAvatar: userAvatar || DUMMY_AVATAR_URL,
    message: event.text,
    channelId: event.channel,
  };
};

const addChannelToStore = async ({
  event,
  client,
  workspaceId,
}: {
  event: EventWithMessage;
  client: any;
  workspaceId: string;
}) => {
  if (!channelStore[workspaceId]) channelStore[workspaceId] = {};

  if (!channelStore[workspaceId][event.channel]) {
    channelStore[workspaceId][event.channel] = await client.conversations.info({
      channel: event.channel,
    });
  }
};

const addTeamToStore = async ({
  client,
  workspaceId,
}: {
  client: any;
  workspaceId: string;
}) => {
  if (!teamStore[workspaceId])
    teamStore[workspaceId] = await client.team.info({
      team: workspaceId,
    });
};

// Listen to messages in each channel the app is installed in
app.event("message", async ({ event, client, logger }) => {
  try {
    if (!("user" in event && typeof event.user === "string"))
      throw new Error("Invalid sender");
    if (!("team" in event && typeof event.team === "string"))
      throw new Error("Invalid sender team");
    if (!("client_msg_id" in event && typeof event.client_msg_id === "string"))
      throw new Error("Invalid message received");

    const hostTeam = (await client.auth.teams.list()).teams![0];
    const sender = await client.users.info({ user: event.user });

    // If external user, add message to store
    if (sender.user!.team_id !== hostTeam.id)
      addMessageToStore({
        // @ts-ignore - error is handled above
        event: event,
        workspaceId: hostTeam.id as string,
        userAvatar: sender.user?.profile?.image_72,
        userId: sender.user!.id as string,
      });

    await addChannelToStore({
      workspaceId: hostTeam.id as string,
      // @ts-ignore - error is handled above
      event,
      client,
    });
    await addTeamToStore({ workspaceId: hostTeam.id as string, client });
  } catch ({ message }) {
    logger.error(message);
  }
});

// Listen for users opening your App Home
app.event("app_home_opened", async ({ event, client, logger }) => {
  try {
    // @ts-ignore
    await publishToView(event.view.team_id, event.user)

  } catch (error) {
    logger.error(
      inspect(error, { showHidden: false, depth: null, colors: true })
    );
  }
});



app.action('static_select-action', async ({ ack,body,payload }) => {
  await ack();
  // Update the message to reflect the action

  // @ts-ignore
  const value = payload.selected_option?.value;
  if (value?.endsWith("-1")) {
    const valueArraySplit=  value.split("-")
    const team= valueArraySplit[1];
    const messageTs = valueArraySplit[2]

    await removeMessageFromStoreAndPublish({team, messageTs, user: body.user.id})
  }
});


const removeMessageFromStoreAndPublish = async ({
  team,
  messageTs,
  user
}: { team: string, messageTs: string, user: string }) => {
  if (!messageStore[team]) return

  if (messageStore[team][messageTs]) delete messageStore[team][messageTs]

  // republish
  await publishToView(team, user)
}


const publishToView = async (hostTeamId: string, userId: string) => {
  try {
  // @ts-ignore
  const generatedBlocks = Object.values(
      // @ts-ignore
      messageStore[hostTeamId] || {}
  ).reduce((acc, item) => {
    // @ts-ignore
    acc = acc.concat([
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*<@${item.userId}>* in *<${teamStore[hostTeamId].team.url}archives/${item.channelId}|#${channelStore[hostTeamId][item.channelId].channel.name}>* \n ${item.event.blocks[0].elements[0].elements[0].text}`,
        },
      },
      {
        dispatch_action: true,
        type: "input",
        element: {
          type: "static_select",
          placeholder: {
            type: "plain_text",
            text: "Select an option",
            emoji: true,
          },
          options: [
            {
              text: {
                type: "plain_text",
                text: "Open",
                emoji: true,
              },
              // @ts-ignore
              value: `value-${hostTeamId}-${item.event.ts}-0`,
            },
            {
              text: {
                type: "plain_text",
                text: "Complete",
                emoji: true,
              },
              // @ts-ignore
              value: `value-${hostTeamId}-${item.event.ts}-1`
            },
          ],
          action_id: "static_select-action",
        },
        label: {
          type: "plain_text",
          text: "Status",
          emoji: true,
        },
      },
    ]);
    return acc;
  }, []);

  const res = await app.client.views.publish({
    user_id: userId,
    view: {
      type: "home",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Welcome home, <@" + userId + "> :house:*",
          },
        },
        {
          type: "section",
          block_id: "header",
          text: {
            type: "mrkdwn",
            text: "Please find the messages from external teams below :smile:",
          },
        },
      ].concat(
        // @ts-ignore
        !generatedBlocks.length
          ? [
              {
                type: "divider",
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "*There are no messages yet* :cry:",
                },
              },
            ]
          : generatedBlocks
      ),
    },
  });
  } catch ({error}) {
    console.error("ERROR", error)
  }
};

app
  .start(3000)
  .then(() => console.log("App started"))
  .catch((err) => console.error(err.message));
