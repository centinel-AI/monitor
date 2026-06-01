import { NextResponse } from 'next/server'

const MANIFEST = `---
apiVersion: v1
kind: Namespace
metadata:
  name: centinela-system
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: centinela-agent
  namespace: centinela-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: centinela-reader
rules:
  - apiGroups: [""]
    resources: ["events", "pods", "nodes", "namespaces", "services"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "daemonsets", "statefulsets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["autoscaling"]
    resources: ["horizontalpodautoscalers"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: centinela-reader-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: centinela-reader
subjects:
  - kind: ServiceAccount
    name: centinela-agent
    namespace: centinela-system
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: centinela-agent
  namespace: centinela-system
  labels:
    app: centinela-agent
spec:
  replicas: 1
  selector:
    matchLabels:
      app: centinela-agent
  template:
    metadata:
      labels:
        app: centinela-agent
    spec:
      serviceAccountName: centinela-agent
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
      containers:
        - name: agent
          image: ghcr.io/centinel-ai/agent:latest
          imagePullPolicy: Always
          resources:
            limits:
              cpu: 100m
              memory: 128Mi
            requests:
              cpu: 50m
              memory: 64Mi
          env:
            - name: SENTINEL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: centinela-token
                  key: SENTINEL_TOKEN
            - name: SENTINEL_API_URL
              valueFrom:
                secretKeyRef:
                  name: centinela-token
                  key: SENTINEL_API_URL
`

export async function GET(): Promise<NextResponse> {
  return new NextResponse(MANIFEST, {
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  })
}
