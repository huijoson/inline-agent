# Adopt Tampermonkey Userscript for Reservation Automation

Inline utilizes PerimeterX / HUMAN Security bot protection (`px-captcha`), which aggressively blocks standalone headless scripts and unauthenticated HTTP requests. We decided to implement the automation as a Tampermonkey userscript executing directly within the user's active, authenticated Google Chrome browser instance. This eliminates bot challenge roadblocks, preserves existing session credentials, and achieves sub-second DOM reaction times without managing external browser driver binaries.
