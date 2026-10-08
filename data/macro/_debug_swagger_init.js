
window.onload = function() {
  // Build a system
  var url = window.location.search.match(/url=([^&]+)/);
  if (url && url.length > 1) {
    url = decodeURIComponent(url[1]);
  } else {
    url = window.location.origin;
  }
  var options = {
  "swaggerDoc": {
    "openapi": "3.0.0",
    "info": {
      "title": "eSankhyiki CMS API",
      "version": "1.0.0",
      "description": "API docs for CMS admin features"
    },
    "servers": [
      {
        "url": "http://10.24.89.32:4000/api",
        "description": "Production server"
      }
    ],
    "components": {
      "securitySchemes": {
        "bearerAuth": {
          "type": "http",
          "scheme": "bearer",
          "bearerFormat": "JWT"
        }
      }
    },
    "security": [
      {
        "bearerAuth": []
      }
    ],
    "paths": {
      "/esankhyiki/cms/cmsAdminLogin": {
        "post": {
          "summary": "CMS admin login",
          "description": "Logs in a CMS admin and returns a JWT token",
          "tags": [
            "Auth"
          ],
          "requestBody": {
            "required": true,
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "username": {
                      "type": "string"
                    },
                    "password": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          },
          "responses": {
            "200": {
              "description": "Successful login with token"
            },
            "401": {
              "description": "Invalid credentials"
            }
          }
        }
      },
      "/esankhyiki/cms/saveInfographics": {
        "post": {
          "summary": "Save infographics",
          "tags": [
            "CMS"
          ],
          "security": [
            {
              "bearerAuth": []
            }
          ],
          "responses": {
            "200": {
              "description": "Infographics saved"
            }
          }
        }
      },
      "/esankhyiki/cms/getInfographics": {
        "get": {
          "summary": "Get infographics",
          "tags": [
            "CMS"
          ],
          "security": [
            {
              "bearerAuth": []
            }
          ],
          "responses": {
            "200": {
              "description": "List of infographics"
            }
          }
        }
      },
      "/esankhyiki/cms/saveTrends": {
        "post": {
          "summary": "Save visual trends",
          "tags": [
            "CMS"
          ],
          "security": [
            {
              "bearerAuth": []
            }
          ],
          "responses": {
            "200": {
              "description": "Trends saved"
            }
          }
        }
      },
      "/esankhyiki/cms/getTrends": {
        "get": {
          "summary": "Get visual trends",
          "tags": [
            "CMS"
          ],
          "security": [
            {
              "bearerAuth": []
            }
          ],
          "responses": {
            "200": {
              "description": "List of trends"
            }
          }
        }
      },
      "/esankhyiki/cms/getDashBoardData": {
        "get": {
          "summary": "Get dashboard data",
          "tags": [
            "CMS"
          ],
          "security": [
            {
              "bearerAuth": []
            }
          ],
          "responses": {
            "200": {
              "description": "Dashboard data returned"
            }
          }
        }
      },
      "/esankhyiki/cms/saveProduct": {
        "post": {
          "summary": "Save product",
          "tags": [
            "CMS"
          ],
          "security": [
            {
              "bearerAuth": []
            }
          ],
          "responses": {
            "200": {
              "description": "Product saved"
            }
          }
        }
      },
      "/esankhyiki/cms/saveTheme": {
        "post": {
          "summary": "Save theme",
          "tags": [
            "CMS"
          ],
          "security": [
            {
              "bearerAuth": []
            }
          ],
          "responses": {
            "200": {
              "description": "Theme saved"
            }
          }
        }
      },
      "/esankhyiki/cms/saveProductAndTheme": {
        "post": {
          "summary": "Save both product and theme",
          "tags": [
            "CMS"
          ],
          "security": [
            {
              "bearerAuth": []
            }
          ],
          "responses": {
            "200": {
              "description": "Product and theme saved"
            }
          }
        }
      }
    },
    "tags": []
  },
  "customOptions": {}
};
  url = options.swaggerUrl || url
  var urls = options.swaggerUrls
  var customOptions = options.customOptions
  var spec1 = options.swaggerDoc
  var swaggerOptions = {
    spec: spec1,
    url: url,
    urls: urls,
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [
      SwaggerUIBundle.presets.apis,
      SwaggerUIStandalonePreset
    ],
    plugins: [
      SwaggerUIBundle.plugins.DownloadUrl
    ],
    layout: "StandaloneLayout"
  }
  for (var attrname in customOptions) {
    swaggerOptions[attrname] = customOptions[attrname];
  }
  var ui = SwaggerUIBundle(swaggerOptions)

  if (customOptions.oauth) {
    ui.initOAuth(customOptions.oauth)
  }

  if (customOptions.preauthorizeApiKey) {
    const key = customOptions.preauthorizeApiKey.authDefinitionKey;
    const value = customOptions.preauthorizeApiKey.apiKeyValue;
    if (!!key && !!value) {
      const pid = setInterval(() => {
        const authorized = ui.preauthorizeApiKey(key, value);
        if(!!authorized) clearInterval(pid);
      }, 500)

    }
  }

  if (customOptions.authAction) {
    ui.authActions.authorize(customOptions.authAction)
  }

  window.ui = ui
}
