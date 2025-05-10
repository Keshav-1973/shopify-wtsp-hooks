import express, { Request, Response } from "express";

import crypto from "crypto";
import axios from "axios";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import admin, { ServiceAccount } from "firebase-admin";
import dotenv from "dotenv";

declare module "http" {
  interface IncomingMessage {
    rawBody: any;
  }
}

interface ShopifyCheckout {
  id: string;
  name?: string;
  customer?: {
    id?: number;
    email?: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
    state?: string;
    verified_email?: boolean;
    default_address?: {
      address1?: string;
      city?: string;
      country?: string;
      province?: string;
      zip?: string;
      phone?: string;
    };
  };
  email?: string;
  currency?: string;
  created_at?: string;
  completed_at?: string;
  line_items?: {
    id?: number;
    title?: string;
    variant_title?: string;
    sku?: string;
    quantity?: number;
    price?: string;
  }[];
  shipping_address?: {
    first_name?: string;
    last_name?: string;
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    zip?: string;
    country?: string;
    phone?: string;
  };
  billing_address?: {
    first_name?: string;
    last_name?: string;
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    zip?: string;
    country?: string;
    phone?: string;
  };
  total_price?: string;
  subtotal_price?: string;
  total_tax?: string;
  shipping_line?: {
    title?: string;
    price?: string;
  };
  tax_lines?: {
    title?: string;
    price?: string;
    rate?: number;
  }[];
  applied_discount?: {
    title?: string;
    description?: string;
    amount?: string;
    value_type?: string;
  };
  invoice_url?: string;
}

// Initialize dotenv
dotenv.config();

const app = express();

const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  DISCOUNT_CODE,
  IMAGE_URL,
  FIREBASE_PROJECT_ID,
  SHOPIFY_SECRET_KEY = "",
  SERVICE_KEY,
  ABANDONED_CHECKOUT_TEMPLATE,
  ORDER_CREATE_TEMPLATE,
} = process.env;

const key = (): ServiceAccount | null => {
  if (SERVICE_KEY) {
    try {
      const serviceKey = JSON.parse(SERVICE_KEY);
      return {
        projectId: serviceKey?.project_id,
        clientEmail: serviceKey?.client_email,
        privateKey: serviceKey?.private_key,
      };
    } catch (error) {
      console.log(error, "key parse error");
      return null;
    }
  } else {
    return null;
  }
};

// 🧠 Full name helper function
function getFullName(checkout: ShopifyCheckout): string {
  const nameFromCustomer = `${checkout?.customer?.first_name ?? ""} ${
    checkout?.customer?.last_name ?? ""
  }`.trim();
  const nameFromShipping = `${checkout?.shipping_address?.first_name ?? ""} ${
    checkout?.shipping_address?.last_name ?? ""
  }`.trim();
  const nameFromBilling = `${checkout?.billing_address?.first_name ?? ""} ${
    checkout?.billing_address?.last_name ?? ""
  }`.trim();

  if (nameFromCustomer) return nameFromCustomer;
  if (nameFromShipping) return nameFromShipping;
  if (nameFromBilling) return nameFromBilling;

  return "Unknown User";
}

const finalServiceKey = key();

if (finalServiceKey) {
  admin.initializeApp({
    credential: admin.credential.cert(finalServiceKey),
    projectId: FIREBASE_PROJECT_ID,
  });

  const db = admin.firestore();

  app.use(
    express.json({
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  app.post(
    "/webhooks/checkouts/update",
    async (req: Request, res: Response) => {
      console.log("✅ Shopify Checkout Webhook hit");

      const hmac = req.get("X-Shopify-Hmac-Sha256");
      if (!hmac || !SHOPIFY_SECRET_KEY) {
        console.log("❌ Missing HMAC or SECRET_KEY");
        return res.sendStatus(403);
      }

      const computedHmac = crypto
        .createHmac("sha256", SHOPIFY_SECRET_KEY)
        .update(req.rawBody.toString("utf8"))
        .digest("base64");

      if (computedHmac !== hmac) {
        console.log("❌ HMAC verification failed");
        return res.sendStatus(403);
      }

      res.sendStatus(200); // Respond to Shopify

      const checkout: ShopifyCheckout = req.body;
      const checkoutId = checkout.id;

      if (checkout.completed_at) {
        console.log("ℹ️ Checkout already completed, no WhatsApp sent.");
        return;
      }

      const rawPhone =
        checkout.customer?.phone ??
        checkout.shipping_address?.phone ??
        checkout.billing_address?.phone;

      if (!rawPhone) {
        console.log("⚠️ No phone number found");
        return;
      }

      const phoneNumber = parsePhoneNumberFromString(rawPhone, "IN");
      const fullName = getFullName(checkout);

      if (phoneNumber) {
        if (!phoneNumber.isValid()) {
          console.log(`❌ Invalid phone number: ${rawPhone}`);
          return;
        } else {
          const sanitizedPhone = phoneNumber.number;
          const customerName = checkout.customer?.first_name ?? "there";

          // ✅ Deduplication: check if this checkoutId already processed
          const existing = await db
            .collection("whatsappLogs")
            .where("checkoutId", "==", checkoutId)
            .get();

          if (!existing.empty) {
            console.log(`🔁 Already processed checkoutId ${checkoutId}`);
            return;
          }

          // ✅ Check last message time for this phone
          const recentMessages = await db
            .collection("whatsappLogs")
            .where("phone", "==", sanitizedPhone)
            .orderBy("timestamp", "desc")
            .limit(1)
            .get();

          const hh = recentMessages.docs[0].data().timestamp.toDate() as any;
          const now = new Date() as any;
          if (!recentMessages.empty && now - hh < 24 * 60 * 60 * 1000) {
            console.log("⏱️ WhatsApp already sent in last 24h");
            return;
          }

          const messageData = {
            messaging_product: "whatsapp",
            to: sanitizedPhone,
            type: "template",
            template: {
              name: ABANDONED_CHECKOUT_TEMPLATE,
              language: { code: "en_US" },
              components: [
                {
                  type: "header",
                  parameters: [
                    {
                      type: "image",
                      image: {
                        link: IMAGE_URL,
                      },
                    },
                  ],
                },
                {
                  type: "body",
                  parameters: [
                    { type: "text", text: customerName },
                    { type: "text", text: DISCOUNT_CODE },
                  ],
                },
                {
                  type: "button",
                  sub_type: "COPY_CODE",
                  index: 0,
                  parameters: [
                    { type: "coupon_code", coupon_code: DISCOUNT_CODE },
                  ],
                },
              ],
            },
          };

          try {
            const response = await axios.post(
              `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
              messageData,
              {
                headers: {
                  Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                  "Content-Type": "application/json",
                },
              }
            );

            console.log("✅ WhatsApp message sent:", response.data);

            await db.collection("whatsappLogs").add({
              fullName: fullName,
              phone: sanitizedPhone,
              messageId: response?.data?.messages?.[0]?.id,
              checkoutId,
              status: response?.data?.messages?.[0]?.message_status,
            });
          } catch (error: any) {
            const errorMsg = error.response?.data ?? error.message;
            console.error("❌ WhatsApp send failed:", errorMsg);
            await db.collection("whatsappLogs").add({
              fullName: fullName,
              phone: sanitizedPhone,
              checkoutId,
              status: "failed",
              timestamp: admin.firestore.Timestamp.now(),
              error: errorMsg,
            });

            // Optional: retry logic (e.g., schedule or use queue system)
          }
        }
      }
    }
  );

  app.post("/webhooks/orders/create", async (req: Request, res: Response) => {
    console.log("✅ Shopify Order Create Webhook hit");

    const hmac = req.get("X-Shopify-Hmac-Sha256");
    if (!hmac || !SHOPIFY_SECRET_KEY) {
      console.log("❌ Missing HMAC or SECRET_KEY");
      return res.sendStatus(403);
    }

    const computedHmac = crypto
      .createHmac("sha256", SHOPIFY_SECRET_KEY)
      .update(req.rawBody.toString("utf8"))
      .digest("base64");

    if (computedHmac !== hmac) {
      console.log("❌ HMAC verification failed");
      return res.sendStatus(403);
    }

    res.sendStatus(200); // Respond to Shopify

    const checkout: ShopifyCheckout = req.body;
    const fullName = getFullName(checkout);

    const rawPhone =
      checkout.customer?.phone ??
      checkout.shipping_address?.phone ??
      checkout.billing_address?.phone;

    if (!rawPhone) {
      console.log("⚠️ No phone number found");
      return;
    }

    const phoneNumber = parsePhoneNumberFromString(rawPhone, "IN");

    if (phoneNumber) {
      if (!phoneNumber.isValid()) {
        console.log(`❌ Invalid phone number: ${rawPhone}`);
        return;
      } else {
        const sanitizedPhone = phoneNumber.number;
        const customerName = checkout.customer?.first_name ?? "there";
        const totalAmount = parseFloat(checkout.total_price ?? "0");

        const messageData = {
          messaging_product: "whatsapp",
          to: sanitizedPhone,
          type: "template",
          template: {
            name: ORDER_CREATE_TEMPLATE,
            language: { code: "en" },
            components: [
              {
                type: "header",
                parameters: [
                  {
                    type: "image",
                    image: {
                      link: IMAGE_URL,
                    },
                  },
                ],
              },
              {
                type: "body",
                parameters: [
                  { type: "text", text: customerName },
                  { type: "text", text: `${checkout.id}` },
                  { type: "text", text: `${totalAmount}` },
                ],
              },
            ],
          },
        };

        try {
          const response = await axios.post(
            `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            messageData,
            {
              headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                "Content-Type": "application/json",
              },
            }
          );

          console.log("✅ WhatsApp message sent:", response.data);

          await db.collection("whatsappLogs").add({
            fullName: fullName,
            phone: sanitizedPhone,
            messageId: response?.data?.messages?.[0]?.id,
            checkoutId: checkout?.id,
            status: response?.data?.messages?.[0]?.message_status,
          });
        } catch (error: any) {
          const errorMsg = error.response?.data ?? error.message;

          console.error("❌ WhatsApp send failed:", errorMsg);
          await db.collection("whatsappLogs").add({
            fullName: fullName,
            phone: sanitizedPhone,
            checkoutId: checkout?.id,
            status: "failed",
            timestamp: admin.firestore.Timestamp.now(),
            error: errorMsg,
          });
        }
      }
    }
  });

  const PORT = process.env.PORT ?? 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}
