
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is missing from .env");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function testOpenAI() {
  const startTime = Date.now();

  try {
    console.log("Sending request to OpenAI...");

    const response = await client.responses.create({
      model: "gpt-6-luna",
      input: "Reply with exactly: Hello ApplyFlow AI"
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log("SUCCESS:", response.output_text);
    console.log("Response time:", duration, "seconds");

  } catch (error) {
    console.error("OPENAI ERROR:", error.message);
    console.error("STATUS:", error.status);
    console.error("CODE:", error.code);
  }
}

testOpenAI();
