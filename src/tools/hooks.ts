/** Webhooks: hooks/subscribe, hooks/unSubscribe. */

import * as z from 'zod';
import { callApi, DESTRUCTIVE, type ToolContext } from './shared.js';

const EVENTS = [
  'order_created',
  'order_paid',
  'order_update',
  'user_signup',
  'user_update',
  'request_call_me',
  'comments_created',
] as const;

const EVENT_DESCRIPTIONS = [
  '- order_created: a customer checked out, or an order was created in the admin panel',
  '- order_paid: an order became paid',
  '- order_update: an order status changed to anything other than 1 (new)',
  '- user_signup: a customer registered',
  '- user_update: a customer changed their email, phone, name, country or city',
  '- request_call_me: a callback request was submitted',
  '- comments_created: a review was posted (not fired for reviews left by store admins)',
].join('\n');

const DELIVERY_NOTES =
  'Horoshop sends the payload as an HTTP PUT with a JSON body. A queue runs every 5 minutes, so ' +
  'expect a delay. If your endpoint answers anything other than 2xx, Horoshop retries roughly ' +
  'every 10 minutes, up to 10 times. Your endpoint should also handle HTTP DELETE, which ' +
  'Horoshop sends if the subscription is removed on its side.';

export function registerWebhookTools(ctx: ToolContext): void {
  if (ctx.config.readOnly) return;

  ctx.server.registerTool(
    'horoshop_webhook_subscribe',
    {
      title: 'Subscribe to a Horoshop webhook',
      description:
        'Registers a URL to receive an event from the store (API function hooks/subscribe). ' +
        'Returns the subscription id — save it, because unsubscribing requires it and there is ' +
        'no way to list existing subscriptions through the API.\n\n' +
        `Events:\n${EVENT_DESCRIPTIONS}\n\n${DELIVERY_NOTES}\n\n` +
        'At most 5 subscriptions per event; past that Horoshop answers ' +
        '"Subscriptions limit for current event has been reached". Since subscriptions cannot be ' +
        'listed, do not create one speculatively — you may quietly burn one of the five slots.',
      inputSchema: z.object({
        event: z.enum(EVENTS).describe('Which event to subscribe to.'),
        target_url: z
          .string()
          .url()
          .describe('URL Horoshop will PUT the event payload to. Must be publicly reachable.'),
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ event, target_url }) =>
      callApi(ctx, 'hooks/subscribe', { event, target_url }, {
        notes: [
          'Save the returned "id" together with this exact target_url — horoshop_webhook_unsubscribe ' +
            'needs both, and the API cannot list subscriptions.',
        ],
      }),
  );

  ctx.server.registerTool(
    'horoshop_webhook_unsubscribe',
    {
      title: 'Unsubscribe from a Horoshop webhook',
      description:
        'Removes a webhook subscription (API function hooks/unSubscribe). Needs both the id ' +
        'returned by horoshop_webhook_subscribe and the exact target_url it was registered with. ' +
        'Horoshop answers HTTP 410 Gone on success.',
      inputSchema: z.object({
        id: z.number().int().describe('Subscription id from horoshop_webhook_subscribe.'),
        target_url: z.string().url().describe('The URL the subscription was registered with.'),
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ id, target_url }) => callApi(ctx, 'hooks/unSubscribe', { id, target_url }),
  );
}
