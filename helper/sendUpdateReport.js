const nodemailer = require("nodemailer");
const config = require("../config.json");

async function sendUpdateReportEmail(mailOptions) {
  try {
    console.log("Sending the Update Report to User --------->");

    // Create a transporter
    let transporter = nodemailer.createTransport({
      host: config.SMTP_Hostname,
      port: config.SMTP_Port,
      secure: false,
      auth: {
        user: config.SMTP_Username,
        pass: config.SMTP_Password,
      },
    });

    return await transporter.sendMail(mailOptions);

  } catch (error) {
    console.log(
      "Error occurred while sending the report to user ------------>",
      error
    );
    return false;
  }
}

module.exports = sendUpdateReportEmail;