import stripe
import requests
from stripe import StripeClient
from .clients import openai_client

stripe.api_key = "sk_test"
client = StripeClient("sk_test")


def run(customer_id, opts):
    stripe.Customer.create(email="a@b.c", name="A")
    stripe.checkout.Session.create(mode="payment", payment_method_types=["card"], **opts)
    client.v1.customers.retrieve(customer_id)
    client.customers.create(params={"email": "x@y.z"})
    stripe.Webhook.construct_event("p", "s", "k")
    openai_client.images.generate(prompt="a dog")
    openai_client.chat.completions.create(model="gpt-4o", messages=[{"role": "user", "content": "hi"}])
    requests.post("https://api.openai.com/v1/images/generations", json={"prompt": "x", "model": "gpt-image-1"})
    requests.get(f"https://api.github.com/repos/{customer_id}/x/pulls", params={"state": "open"})
