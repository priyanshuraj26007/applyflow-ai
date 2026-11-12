
const samplePost = `
WE'RE HIRING | Product Manager | Eminence Technology

We are looking for a Product Manager to join our team.

Recruiter: Drishty Dawra
Email: drishty@eminencetechnology.com

Experience: 4+ years
Location: Mohali
Joining: Immediate Joiners Preferred

Interested candidates can share their resumes at the email address above.
`;

async function testJobAnalysis() {
  try {
    console.log("Sending LinkedIn post to ApplyFlow AI...");

    const response = await fetch(
      "http://127.0.0.1:3000/api/analyze-job",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          postText: samplePost
        })
      }
    );

    const result = await response.json();

    console.log("\nAPI STATUS:", response.status);
    console.log("\nAI ANALYSIS RESULT:");
    console.log(JSON.stringify(result, null, 2));

  } catch (error) {
    console.error("TEST FAILED:", error.message);
  }
}

testJobAnalysis();
