
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

async function testGemini() {
  try {
    console.log("Sending direct request to Gemini...");

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: "Reply with exactly: Hello ApplyFlow AI"
    });

    console.log("SUCCESS:", response.text);

  } catch (error) {
    console.error("FAILED:", error);
  }
}

testGemini();
