import { EmailLayout } from '../interfaces';

export const baseLayout: EmailLayout = {
  name: 'base',
  html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta http-equiv="x-ua-compatible" content="ie=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta
      name="format-detection"
      content="telephone=no, date=no, address=no, email=no"
    />
    <title>nestrova</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap"
      rel="stylesheet"
    />
    <!--[if mso]>
      <xml>
        <o:OfficeDocumentSettings>
          <o:PixelsPerInch>96</o:PixelsPerInch>
        </o:OfficeDocumentSettings>
      </xml>
      <style>
        td,
        th,
        div,
        p,
        a,
        h1,
        h2,
        h3,
        h4,
        h5,
        h6 {
          font-family: 'Segoe UI', Arial, sans-serif;
          mso-line-height-rule: exactly;
        }
      </style>
    <![endif]-->
    <style>
      body {
        background: #0d1117;
        margin: 0;
        padding: 0;
        font-family: 'Fellix', 'Segoe UI', Arial, sans-serif;
        color: #ffffff;
        font-size: 16px;
        line-height: 1.6;
      }

      .container {
        background: #161b22;
        width: 580px;
        max-width: 100%;
        margin: 40px auto;
        border-radius: 6px;
        padding: 36px 40px;
        text-align: left;
        box-shadow: 0 0 10px rgba(255, 255, 255, 0.05);
      }

      .logo img {
        width: 50%;
        display: block;
        margin: 32px auto;
      }

      h1,
      p,
      a,
      .greeting,
      .footer,
      .details-label,
      .details-value {
        color: #f0f6fc !important;
      }

      a {
        color: #58a6ff;
      }

      .cta-btn {
        background: #238636;
        color: #ffffff !important;
      }

      .cta-btn:hover {
        background: #2ea043;
      }

      .code-box {
            background: #eaf3fb; /* Soft Blue */
            color: #000000ff;
            font-size: 26px;
            letter-spacing: 0.5em;
            font-weight: bold;
            padding: 18px 0;
            text-align: center;
            border-radius: 4px;
            margin: 24px 0 32px 0;
            border: 1.5px dashed #d0e6fd; /* Soft Blue */
            -webkit-text-size-adjust: 100%;
          }

      .details-card {
        background: #21262d;
        border: 1px solid #30363d;
      }

      .details-row {
        border-bottom: 1px solid #30363d;
      }

      .footer {
        border-top: 1px solid #30363d;
      }

      .footer-address,
      .footer-copyright {
        color: #8b949e;
      }

      .tagline {
        color: #8b949e;
      }

      .social-icons {
            padding: 0 0 8px 0;
            text-align: center;
          }

      .social-icons a {
            display: inline-block;
            margin: 0 10px;
            line-height: 1;
          }

      .social-icons img {
            vertical-align: middle;
            display: block;
          }

      @media (max-width: 600px) {
        .container {
          padding: 24px 16px;
        }
      }
    </style>
  </head>
  <body>
    <div
      style="
        display: none;
        font-size: 0px;
        line-height: 0px;
        max-height: 0px;
        max-width: 0px;
        opacity: 0;
        overflow: hidden;
        mso-hide: all;
      "
    >
      {{previewText}}
    </div>
    <table
      width="100%"
      cellpadding="0"
      cellspacing="0"
      border="0"
      bgcolor="#0d1117"
      style="background: #0d1117; min-width: 100%; font-size: 16px;"
    >
      <tr>
        <td align="center">
          <table
            class="container"
            width="580"
            cellpadding="0"
            cellspacing="0"
            border="0"
            bgcolor="#161b22"
            style="
              background: #161b22;
              width: 580px;
              max-width: 100%;
              margin: 40px auto 20px auto;
              border-radius: 6px;
              padding: 36px 40px;
              text-align: left;
              font-size: 16px;
            "
          >
            <tbody>
              <tr>
                <td style="width: 580px; max-width: 100%; padding: 0; font-size: 16px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 16px;">
                    <tr>
                      <td class="header" style="text-align: left; margin-bottom: 32px; font-size: 16px;">
                        <div class="logo" style="margin-bottom: 8px">
                          <img
                            src=""
                            alt="project logo"
                            width="50%"
                            style="
                              width: 50%;
                              height: auto;
                              display: block;
                              margin: 32px 0;
                            "
                          />
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <h1
                          class="greeting"
                          style="
                            font-size: 18px;
                            line-height: 1.4;
                            font-weight: normal;
                            color: #f0f6fc;
                            margin-bottom: 24px;
                          "
                        >
                          Hi {{userName}},
                        </h1>
                      </td>
                    </tr>
                    <tbody style="font-size: 16px; color: #f0f6fc;">
                      {{{content}}}
                    </tbody>
                    <tr>
                      <td style="font-size: 16px;">
                        <div class="closing-message" style="font-size: 16px;">
                          <p
                            class="text"
                            style="
                              margin-bottom: 16px;
                              font-size: 16px;
                            "
                          >
                            If you have any questions or need assistance, our support team is always here to help. You can reach us at
                            <a
                              href="{{supportEmail}}"
                              style="color: #58a6ff; text-decoration: none;"
                              >{{supportEmail}}</a
                            >.
                          </p>
                          <p class="text" style="margin-bottom: 16px; font-size: 16px;">
                            {{closingMessage}}
                          </p>
                          <p class="signature" style="font-size: 16px; margin-bottom: 0;">
                            {{signature}}
                          </p>
                          <p class="tagline" style="font-size: 14px; color: #8b949e; margin-bottom: 0;">
                            {{tagline}}
                          </p>
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <td style="font-size: 16px;">
                        <div
                          class="footer"
                          style="
                            text-align: center;
                            color: #f0f6fc;
                            font-size: 15px;
                            margin-top: 32px;
                            border-top: 1px solid #30363d;
                            padding-top: 16px;
                          "
                        >
                          <div
                            class="social-icons"
                            style="padding: 0 0 8px 0; text-align: center"
                          >
                            <a href="">
                              <img
                                src=""
                                alt="LinkedIn"
                                height="15"
                                style="
                                    vertical-align: middle;
                                    display: inline-block;
                                    margin: 0 10px;
                                    filter: brightness(0) invert(1);
                                    "
                              />
                            </a>
                            <a href="">
                              <img
                                src=""
                                alt="Instagram"
                                height="15"
                                      style="
                                        vertical-align: middle;
                                        display: inline-block;
                                        margin: 0 10px;
                                        filter: brightness(0) invert(1);
                                      "
                              />
                            </a>
                            <a href="">
                              <img
                                src=""
                                alt="Twitter"
                                height="15"
                                style="
                                    vertical-align: middle;
                                    display: inline-block;
                                    margin: 0 10px;
                                    filter: brightness(0) invert(1);
                                  "
                              />
                            </a>
                          </div>
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </tbody>
          </table>
          <div
            class="footer-address"
            style="text-align: center; color: #8b949e; font-size: 12px; margin-top: 40px;"
          >
            company address
          </div>
          <div
            style="text-align: center; color: #8b949e; font-size: 12px; margin-bottom: 2px;"
          >
            <a href="" style="color: #58a6ff; text-decoration: none; margin: 0 8px;">Privacy Policy</a>
            <span style="color: #8b949e">|</span>
            <a href="" style="color: #58a6ff; text-decoration: none; margin: 0 8px;">Terms & Conditions</a>
          </div>
          <div
            class="footer-copyright"
            style="text-align: center; color: #8b949e; margin-bottom: 40px; font-size: 12px;"
          >
            Copyright &copy; company name ${new Date().getFullYear()}. All rights reserved.
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>
`,
};
