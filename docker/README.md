Optional build input. If your network re-signs HTTPS (a corporate or campus
proxy), put its CA certificate here as `extra-ca.crt` before `docker build`;
the image will trust it for apt, npm and pip. The file is git-ignored.
