# Use nginx as base image
FROM nginx:alpine

# Create a simple HTML page
RUN echo '<html><head><title>Hello Arasaka</title></head><body><h1>Hello World from Arasaka!</h1><p>This is an updated test deployment.</p><p>Timestamp: '"$(date)"'</p></body></html>' > /usr/share/nginx/html/index.html

# Expose port 80
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"] 