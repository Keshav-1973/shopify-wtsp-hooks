import express, { Request, Response } from "express";

import crypto from "crypto";
import axios from "axios";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import admin, { ServiceAccount } from "firebase-admin";
import dotenv from "dotenv";
import * as http from "http";

interface Options {
  inflate?: boolean;
  limit?: number | string;
  type?: string | string[] | ((req: http.IncomingMessage) => any);
  verify?(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    buf: Buffer,
    encoding: string
  ): void;
}
declare module "http" {
  interface IncomingMessage {
    rawBody: any;
  }
}

interface ShopifyCheckout {
  id: string;
  customer?: {
    first_name?: string;
    phone?: string;
  };
  shipping_address?: {
    phone?: string;
  };
  billing_address?: {
    phone?: string;
  };
  completed_at?: string;
}

// Initialize dotenv
dotenv.config();

const app = express();

const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  DISCOUNT_CODE,
  DISCOUNT_IMAGE_URL,
  FIREBASE_PROJECT_ID,
  SHOPIFY_SECRET_KEY = "",
  SERVICE_KEY,
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
              name: "abd_chk",
              language: { code: "en_US" },
              components: [
                {
                  type: "header",
                  parameters: [
                    {
                      type: "image",
                      image: {
                        link: DISCOUNT_IMAGE_URL,
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
              phone: sanitizedPhone,
              messageId: response?.data?.messages?.[0]?.id,
              checkoutId,
              status: response?.data?.messages?.[0]?.message_status,
            });
          } catch (error: any) {
            const errorMsg = error.response?.data ?? error.message;
            console.error("❌ WhatsApp send failed:", errorMsg);

            await db.collection("whatsappLogs").add({
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

  const PORT = process.env.PORT ?? 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}
