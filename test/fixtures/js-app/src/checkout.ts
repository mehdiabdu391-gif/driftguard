import { stripe, getStripe } from '@/lib/stripe';
import ai from './lib/ai';
import axios from 'axios';

const OPENAI = 'https://api.openai.com/v1';

export async function checkout(customerId: string, extra: Record<string, string>) {
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    line_items: [{ price: 'price_123', quantity: 1 }],
    mode: 'payment',
  });
  await getStripe().customers.update(customerId, { ...extra });
  await stripe.accounts.retrieve();
  stripe.webhooks.constructEvent('a', 'b', 'c');
  const img = await ai.images.generate({ prompt: 'a cat', size: '1024x1024' });
  const chat = await ai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  await fetch(`${OPENAI}/images/generations`, { method: 'POST', body: JSON.stringify({ prompt: 'x' }) });
  await fetch('https://api.stripe.com/v1/customers/' + customerId);
  await axios.post('https://api.github.com/repos/o/r/issues', { title: 't' });
  await fetch('https://example.com/not-a-provider');
  return { session, img, chat };
}
